/**
 * Orchestrator-owned session tree: root plus verified same-server delegates.
 *
 * Each scope keeps only its own samples; the tree never sums TPS across
 * concurrent agents. Discovery is paginated, abortable and bounded.
 *
 * Load orchestration rules (every path funnels through one bounded queue):
 * - The central per-scope queue (`enqueueScopeLoads`) tracks in-flight
 *   scopes: a scope already fetching is never started twice, and event
 *   bursts collapse into at most one coalesced repeat. Initial loads,
 *   manual refreshes, reconnects, renewals and event refreshes all share
 *   its concurrency limit. No full-tree reload per delta.
 * - Child controllers are tree-private (never in the shared cache), so
 *   opening a child as a primary session elsewhere always builds a
 *   separate live controller: its events are never muted by this tree.
 *   The tree is their sole router; private children dispose with it.
 * - The root scope stays shared through the shared controller cache
 *   (see shared.ts): retained in place, released (never disposed
 *   or cancelled) by this tree, so closing one surface never breaks the
 *   other. The tree loads the root on full passes and receives live
 *   updates through `onUpdate`; header and panel share this tree.
 * - Renewal swaps transports with `{ reload: false }` (which still
 *   cancels the old generation, so late old-transport resolutions never
 *   publish) and re-queues centrally instead of auto-loading every scope.
 * - A failed or truncated discovery keeps previously known scopes and
 *   reports partial/stale explicitly instead of silently dropping children.
 */

import {
  SessionMetricsController,
  sessionKey,
  type AdapterSnapshot,
} from "./adapter.js";
import { createEmptyAdapterSnapshot } from "./snapshots.js";
import type { DiagnosticReason } from "./definition.js";
import { releaseController, retainController } from "./shared.js";
import { DelegateActivity, readIdleActivity, readStatusActivity, readWorkActivity } from "./activity.js";
import { LiveTracker, type LiveScopeSnapshot } from "./live.js";
import { discoverDescendants, type ListSessionsPage, type TreeNode } from "./tree.js";
import { readCreatedSession, readEventSessionID, type TransportSeam } from "./transport.js";
import type { OpenCodeEvent } from "@opencode/client/promise";

export type TreeStatus =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "partial"
  | "error"
  | "disconnected";

export interface ChildScope {
  readonly sessionID: string;
  readonly title: string | null;
  readonly agent: string | null;
  readonly depth: number;
  readonly parentID: string;
  readonly snapshot: AdapterSnapshot;
}

export interface TreeSnapshot {
  readonly status: TreeStatus;
  readonly rootSessionID: string;
  readonly rootTitle: string | null;
  readonly rootAgent: string | null;
  readonly root: AdapterSnapshot;
  readonly children: readonly ChildScope[];
  /** Verified working descendant the header follows, or null for the root. */
  readonly activeDelegateID?: string | null;
  /** True when discovery hit a cap/cycle/error or any scope is unusable. */
  readonly partial: boolean;
  readonly error: string | null;
  /** First-party reason as data; null for verbatim third-party failures. */
  readonly errorReason?: DiagnosticReason | null;
  /** Bounded transient live/TTFT snapshots for tracked scopes only. */
  readonly live?: readonly LiveScopeSnapshot[];
}

export interface TreeControllerOptions {
  readonly serverID: string;
  readonly rootSessionID: string;
  readonly listPage: ListSessionsPage;
  readonly seamForSession: (sessionID: string) => TransportSeam;
  readonly subscribeTree: (notify: (details: OpenCodeEvent) => void) => () => void;
  readonly isConnected: () => boolean;
  readonly refs: { readonly client: unknown; readonly data: unknown };
  /** Timestamp-free running snapshot for header bootstrap (Data.session.active). */
  readonly snapshotRunning?: () => readonly string[];
  readonly concurrency?: number;
  readonly debounceMs?: number;
  readonly pageLimit?: number;
  readonly safetyPageCap?: number;
  readonly maxSessions?: number;
  /** Injected monotonic local clock for live timing; tests override it. */
  readonly now?: () => number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DEBOUNCE_MS = 250;
const LIVE_TICK_MS = 250;
const LIVE_PUBLISH_MS = 250;

function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

interface Tracked {
  controller: SessionMetricsController;
  unwatch: () => void;
  info: TreeNode | null;
  /** Shared-cache key for the root (released, never disposed, by this tree). */
  key: string | null;
  /** True only for the root, which stays shared through the shared controller cache. */
  shared: boolean;
}

function childTitle(node: TreeNode): string | null {
  const title = node.info.title;
  return typeof title === "string" && title.length > 0 ? title : null;
}

function childAgent(node: TreeNode): string | null {
  const agent = node.info.agent;
  return typeof agent === "string" && agent.length > 0 ? agent : null;
}

/** Tree-exclusive child scopes are routed only by the tree: mute the seam's own subscription. */
function muteScopeEvents(seam: TransportSeam): TransportSeam {
  return { ...seam, subscribe: () => () => {} };
}

export class SessionTreeController {
  readonly serverID: string;
  readonly rootSessionID: string;
  readonly key: string;
  private listPage: ListSessionsPage;
  private seamForSession: (sessionID: string) => TransportSeam;
  private subscribeTree: (notify: (details: OpenCodeEvent) => void) => () => void;
  private isConnectedFn: () => boolean;
  private refs: { readonly client: unknown; readonly data: unknown };
  private snapshotRunning: () => readonly string[];
  private readonly activity = new DelegateActivity();
  private readonly live = new LiveTracker();
  private readonly clock: () => number;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private lastLivePublish = Number.NEGATIVE_INFINITY;
  private readonly concurrency: number;
  private readonly debounceMs: number;
  private readonly pageLimit?: number;
  private readonly safetyPageCap?: number;
  private readonly maxSessions?: number;

  private tracked = new Map<string, Tracked>();
  private snapshots = new Map<string, AdapterSnapshot>();
  private unsubscribe: (() => void) | null = null;
  /** Current tree-subscription token; stale queued callbacks never publish. */
  private subscriptionToken = 0;
  private subscribed = false;
  private listeners = new Set<(snap: TreeSnapshot) => void>();
  private generation = 0;
  private disposed = false;
  private discoveryAbort: AbortController | null = null;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRefresh = new Set<string>();
  private pendingDiscovery = false;
  private loadQueue: string[] = [];
  private queuedIds = new Set<string>();
  /** Currently fetching scopes mapped to their unique run token. */
  private inflightRuns = new Map<string, number>();
  private runToken = 0;
  /** One coalesced repeat per scope requested while it was in flight. */
  private repeatLoads = new Set<string>();
  private activeLoads = 0;
  private treePartial = false;
  private treeError: string | null = null;
  private treeErrorReason: DiagnosticReason | null = null;
  private treeStatus: TreeStatus = "idle";

  constructor(options: TreeControllerOptions) {
    this.serverID = options.serverID;
    this.rootSessionID = options.rootSessionID;
    this.key = sessionKey(options.serverID, options.rootSessionID);
    this.listPage = options.listPage;
    this.seamForSession = options.seamForSession;
    this.subscribeTree = options.subscribeTree;
    this.isConnectedFn = options.isConnected;
    this.refs = options.refs;
    this.snapshotRunning = options.snapshotRunning ?? (() => []);
    this.clock = options.now ?? defaultNow;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pageLimit = options.pageLimit;
    this.safetyPageCap = options.safetyPageCap;
    this.maxSessions = options.maxSessions;
    this.attachTreeSubscription();
  }

  getState(): TreeSnapshot {
    return this.buildSnapshot();
  }

  /**
   * Tree-event subscription with a connection token. The callback captures
   * its token: renewal, disconnect, and disposal invalidate it, so an
   * already-queued callback from the old connection can never publish
   * (unsubscribing alone cannot stop a queued call). No assumption is made
   * that the host stops delivering after unsubscribe.
   */
  private attachTreeSubscription(): void {
    if (this.subscribed || this.disposed) return;
    const token = ++this.subscriptionToken;
    this.unsubscribe = this.subscribeTree((details) => {
      if (token !== this.subscriptionToken || this.disposed) return;
      this.onEvent(details);
    });
    this.subscribed = true;
  }

  private detachTreeSubscription(): void {
    this.subscriptionToken += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribed = false;
  }

  onUpdate(listener: (snap: TreeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    if (this.disposed) return;
    const snap = this.buildSnapshot();
    for (const l of [...this.listeners]) l(snap);
  }

  private rootSnapshot(): AdapterSnapshot {
    return this.snapshots.get(this.rootSessionID) ?? createEmptyAdapterSnapshot();
  }

  /** Verified descendant ids (children with discovered parentID relations). */
  private verifiedChildIDs(): string[] {
    const ids: string[] = [];
    for (const [sessionID, t] of this.tracked) {
      if (sessionID === this.rootSessionID || !t.info) continue;
      ids.push(sessionID);
    }
    return ids;
  }

  /** Header delegate: most recently active verified working descendant, or null. */
  getActiveDelegateID(): string | null {
    if (this.disposed) return null;
    if (!this.isConnectedFn()) return null;
    return this.activity.selectDelegate(this.verifiedChildIDs());
  }

  private liveEligibleIDs(ids: readonly string[]): string[] {
    const eligible: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (id === this.rootSessionID || this.tracked.has(id)) eligible.push(id);
    }
    return eligible;
  }

  private bootstrapLiveFromData(): void {
    try {
      const ids = this.snapshotRunning() ?? [];
      this.live.bootstrapRunning(this.liveEligibleIDs(ids));
    } catch {
      // Live bootstrap is best-effort; explicit events remain authoritative.
    }
  }

  private bootstrapFromData(): void {
    try {
      const ids = this.snapshotRunning() ?? [];
      this.activity.bootstrapRunning(ids);
      this.bootstrapLiveFromData();
    } catch {
      // Bootstrap is best-effort; explicit events remain authoritative.
    }
  }

  /**
   * Idempotent live reconcile of the running set (e.g. a `Data` snapshot
   * that hydrated or changed after mount without a new typed busy event).
   * Touches only delegate activity and emits only when the followed
   * delegate changes: never loads histories, never walks discovery, never
   * polls. Explicit statuses are never overwritten by the timestamp-free
   * guess (see `bootstrapRunning`).
   */
  reconcileRunning(ids: readonly string[]): boolean {
    if (this.disposed) return false;
    if (!this.isConnectedFn()) return false;
    const before = this.getActiveDelegateID();
    let liveChanged = false;
    try {
      this.activity.bootstrapRunning(ids);
      liveChanged = this.live.bootstrapRunning(this.liveEligibleIDs(ids));
    } catch {
      return false;
    }
    const after = this.getActiveDelegateID();
    if (before !== after || liveChanged) {
      this.lastLivePublish = this.clock();
      this.emit();
    }
    this.ensureLiveTimer();
    return before !== after;
  }

  private updateActivity(details: OpenCodeEvent): boolean {
    try {
      const status = readStatusActivity(details);
      if (status) return this.activity.onStatus(status.sessionID, status.liveness, status.created);
      const idle = readIdleActivity(details);
      if (idle) return this.activity.onStatus(idle.sessionID, "idle", idle.created);
      const work = readWorkActivity(details);
      if (work) return this.activity.onDelta(work.sessionID, work.created);
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Publish live state at most four times per second for output deltas.
   * Lifecycle transitions publish immediately. Timer ticks are the only
   * recurring publication path and never fetch or discover.
   */
  private publishLive(immediate: boolean): void {
    if (this.disposed) return;
    const now = this.clock();
    if (immediate || now - this.lastLivePublish >= LIVE_PUBLISH_MS) {
      this.lastLivePublish = now;
      this.emit();
    }
    this.ensureLiveTimer();
  }

  private ensureLiveTimer(): void {
    if (this.disposed || !this.isConnectedFn()) {
      this.stopLiveTimer();
      return;
    }
    const now = this.clock();
    if (this.liveTimer !== null) {
      if (!this.live.needsTick(now)) this.stopLiveTimer();
      return;
    }
    if (!this.live.needsTick(now)) return;
    this.liveTimer = setInterval(() => {
      if (this.disposed || !this.isConnectedFn()) {
        this.stopLiveTimer();
        return;
      }
      const tickNow = this.clock();
      this.live.tick(tickNow);
      if (tickNow - this.lastLivePublish >= LIVE_PUBLISH_MS) {
        this.lastLivePublish = tickNow;
        this.emit();
      }
      if (!this.live.needsTick(tickNow)) this.stopLiveTimer();
    }, LIVE_TICK_MS);
  }

  private stopLiveTimer(): void {
    if (this.liveTimer !== null) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  }

  private observeLive(details: OpenCodeEvent, selectionChanged: boolean): void {
    const sessionID = readEventSessionID(details);
    if (sessionID === null) return;
    if (sessionID !== this.rootSessionID && !this.tracked.has(sessionID)) return;
    const result = this.live.observe(details, this.clock());
    if (!result.changed || result.sessionID === null) return;
    if (selectionChanged) {
      // The tree's existing selection-change emission publishes this same
      // snapshot once; avoid a duplicate emission for the same event.
      this.lastLivePublish = this.clock();
      this.ensureLiveTimer();
      return;
    }
    this.publishLive(result.immediate);
  }

  private buildSnapshot(): TreeSnapshot {
    const root = this.rootSnapshot();
    const children: ChildScope[] = [];
    for (const [sessionID, t] of this.tracked) {
      if (sessionID === this.rootSessionID || !t.info) continue;
      children.push({
        sessionID,
        title: childTitle(t.info),
        agent: childAgent(t.info),
        depth: t.info.depth,
        parentID: t.info.parentID,
        snapshot: this.snapshots.get(sessionID) ?? createEmptyAdapterSnapshot(),
      });
    }
    children.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : 0;
    });
    const activeDelegateID =
      this.disposed || !this.isConnectedFn()
        ? null
        : this.activity.selectDelegate(children.map((c) => c.sessionID));

    let status: TreeStatus = this.treeStatus;
    if (!this.isConnectedFn()) {
      status = "disconnected";
    }
    const childFailed = children.some(
      (c) => c.snapshot.status === "error" || c.snapshot.status === "partial",
    );
    const rootDegraded = root.status === "partial" || root.status === "error";
    const partial = this.treePartial || childFailed || root.status === "partial";
    let error = this.treeError;
    let errorReason: DiagnosticReason | null = this.treeErrorReason;
    if (!error) {
      const failed = children.find((c) => c.snapshot.status === "error");
      if (failed) {
        error = `subagent ${failed.sessionID} unavailable`;
        errorReason = failed.snapshot.reason ?? {
          kind: "child-unavailable",
          sessionID: failed.sessionID,
        };
      } else {
        const incomplete = children.find((c) => c.snapshot.status === "partial");
        if (incomplete) {
          error = incomplete.snapshot.error ?? "partial history in a subagent";
          errorReason = incomplete.snapshot.reason ?? { kind: "partial-child" };
        } else if (rootDegraded) {
          error = root.error ?? "partial history in the current session";
          errorReason = root.reason ?? { kind: "partial-root" };
        }
      }
    }
    // Honest roll-up that never invents a zero: root state dominates, a
    // degraded tree is at best partial, and disconnect wins outright.
    if (status !== "disconnected" && status !== "loading" && status !== "idle") {
      if (root.status === "error") status = partial ? "partial" : "error";
      else if (root.status === "disconnected") status = "disconnected";
      else if (partial) status = "partial";
      else if (root.status === "ready" || children.some((c) => c.snapshot.status === "ready")) status = "ready";
      else if (root.status === "empty" && children.every((c) => c.snapshot.status !== "ready")) status = "empty";
      else status = root.status as TreeStatus;
    }
    return {
      status,
      rootSessionID: this.rootSessionID,
      rootTitle: null,
      rootAgent: null,
      root,
      children,
      activeDelegateID,
      partial,
      error,
      errorReason,
      live: this.live.snapshot(this.tracked.keys(), this.clock()),
    };
  }

  private onEvent(details: OpenCodeEvent): void {
    if (this.disposed) return;
    // A disconnected tree ignores every event: firing after
    // markDisconnected can never repopulate activity, and stale queued
    // callbacks from a previous connection are already dead by token.
    if (!this.isConnectedFn()) return;
    const before = this.getActiveDelegateID();
    // Bookkeeping always runs (status ordering, tombstones, recency), but
    // snapshots expose only the selected delegate id: event-only recency
    // publishes solely when that selection changes. History/discovery
    // scheduling below stays untouched.
    this.updateActivity(details);
    const selectionChanged = before !== this.getActiveDelegateID();
    this.observeLive(details, selectionChanged);
    if (selectionChanged) this.lastLivePublish = this.clock();
    const created = readCreatedSession(details);
    if (created && created.parentID && (created.parentID === this.rootSessionID || this.tracked.has(created.parentID))) {
      this.scheduleDiscovery();
      if (before !== this.getActiveDelegateID()) this.emit();
      return;
    }
    const sid = readEventSessionID(details);
    if (!sid || sid === this.rootSessionID) {
      // Root and non-session activity (status/delta for the delegate set)
      // never triggers a history reload here; a delegate change still emits.
      if (before !== this.getActiveDelegateID()) this.emit();
      return;
    }
    // The shared root controller owns the root scope; only known
    // children refresh here, one scope per event.
    if (this.tracked.has(sid)) {
      this.scheduleRefresh(sid);
    }
    // Unrelated sessions never trigger any reload; pending activity stays
    // cached (bounded) until discovery verifies the relationship.
    if (before !== this.getActiveDelegateID()) this.emit();
  }

  private scheduleDiscovery(): void {
    if (this.disposed || !this.isConnectedFn()) return;
    if (this.pendingDiscovery) return;
    this.pendingDiscovery = true;
    if (this.discoveryTimer !== null) return;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      this.pendingDiscovery = false;
      void this.load();
    }, this.debounceMs);
  }

  private scheduleRefresh(sessionID: string): void {
    if (this.disposed || !this.isConnectedFn()) return;
    this.pendingRefresh.add(sessionID);
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const ids = [...this.pendingRefresh];
      this.pendingRefresh.clear();
      this.enqueueScopeLoads(ids, { repeat: true });
    }, this.debounceMs);
  }

  /**
   * Central bounded loader: the only path the tree uses for scope
   * histories. At most `concurrency` histories fetch at once, on every
   * route (initial, refresh, reconnect, renewal, events). A scope already
   * fetching is never started twice: with `{ repeat: true }` (event
   * flushes) it earns at most one coalesced repeat after completing, so a
   * burst of deltas against a blocked fetch costs one extra pass, not N.
   */
  private enqueueScopeLoads(ids: readonly string[], opts?: { readonly repeat?: boolean }): void {
    if (this.disposed) return;
    for (const id of ids) {
      if (!this.tracked.has(id)) continue;
      if (this.inflightRuns.has(id)) {
        if (opts?.repeat) this.repeatLoads.add(id);
        continue;
      }
      if (this.queuedIds.has(id)) continue;
      this.queuedIds.add(id);
      this.loadQueue.push(id);
    }
    this.pumpQueue();
  }

  private pumpQueue(): void {
    if (this.disposed) return;
    while (this.activeLoads < this.concurrency && this.loadQueue.length > 0) {
      const id = this.loadQueue.shift();
      if (id === undefined) break;
      this.queuedIds.delete(id);
      const t = this.tracked.get(id);
      if (!t) continue;
      // Unique token per run: a stale finally (e.g. an old generation's
      // fetch resolving after a renewal started a new run for the same
      // scope) only matches its own token, so it can never release the
      // new run's slot, decrement the new counter, or steal its repeat.
      const token = ++this.runToken;
      this.inflightRuns.set(id, token);
      this.activeLoads += 1;
      void t.controller
        .load()
        .catch(() => undefined)
        .finally(() => {
          if (this.inflightRuns.get(id) !== token) {
            this.pumpQueue();
            return;
          }
          this.inflightRuns.delete(id);
          this.activeLoads = Math.max(0, this.activeLoads - 1);
          if (this.repeatLoads.delete(id) && !this.disposed && this.tracked.has(id)) {
            this.queuedIds.add(id);
            this.loadQueue.push(id);
          }
          this.pumpQueue();
        });
    }
  }

  /**
   * Real cancellation: drops the generation, aborts in-flight discovery
   * and drops all queue bookkeeping (waiting, in-flight run tokens,
   * repeats), so the next generation re-queues cleanly instead of
   * skipping scopes that were mid-flight. Orphaned worker completions
   * match no token: they only pump, never release another run's slot.
   */
  cancel(): void {
    this.generation += 1;
    this.discoveryAbort?.abort();
    this.discoveryAbort = null;
    this.loadQueue = [];
    this.queuedIds.clear();
    this.inflightRuns.clear();
    this.repeatLoads.clear();
    this.activeLoads = 0;
  }

  /**
   * Renew the pinned connection. Returns true when identities changed:
   * subscriptions are renewed, in-flight work from the old connection is
   * cancelled so it can never publish, transports swap without auto-loading
   * every scope at once, and one bounded full pass follows. The shared root
   * controller is renewed in place (header and panel shares renew the same
   * way; identical refs are a no-op), never disposed by this tree. Stale
   * delegate activity is cleared and re-bootstrapped from the new
   * connection so a restarted server never resurrects old work.
   */
  replaceConnection(next: {
    readonly listPage: ListSessionsPage;
    readonly seamForSession: (sessionID: string) => TransportSeam;
    readonly subscribeTree: (notify: (details: OpenCodeEvent) => void) => () => void;
    readonly isConnected: () => boolean;
    readonly refs: { readonly client: unknown; readonly data: unknown };
    readonly snapshotRunning?: () => readonly string[];
  }): boolean {
    if (this.disposed) return false;
    if (next.refs.client === this.refs.client && next.refs.data === this.refs.data) return false;
    this.cancel();
    this.activity.clear();
    this.live.clear();
    this.stopLiveTimer();
    this.lastLivePublish = Number.NEGATIVE_INFINITY;
    this.listPage = next.listPage;
    this.seamForSession = next.seamForSession;
    this.subscribeTree = next.subscribeTree;
    this.isConnectedFn = next.isConnected;
    this.refs = next.refs;
    if (next.snapshotRunning !== undefined) this.snapshotRunning = next.snapshotRunning;
    this.detachTreeSubscription();
    this.attachTreeSubscription();
    for (const [sessionID, t] of this.tracked) {
      const seam =
        sessionID === this.rootSessionID
          ? this.seamForSession(sessionID)
          : muteScopeEvents(this.seamForSession(sessionID));
      t.controller.replaceTransport(seam, { reload: false });
    }
    void this.load();
    return true;
  }

  /** Retain the shared root controller now so its metrics never wait on discovery. */
  private ensureRoot(): void {
    const seam = this.seamForSession(this.rootSessionID);
    const existing = this.tracked.get(this.rootSessionID);
    if (existing) {
      existing.controller.replaceTransport(seam, { reload: false });
      return;
    }
    const entry = retainController(
      this.serverID,
      this.rootSessionID,
      seam,
      (transport) =>
        new SessionMetricsController({
          serverID: this.serverID,
          sessionID: this.rootSessionID,
          transport,
          ...(this.pageLimit !== undefined ? { pageLimit: this.pageLimit } : {}),
          debounceMs: this.debounceMs,
        }),
      { renewReload: false },
    );
    const unwatch = entry.controller.onUpdate((snap) => {
      this.snapshots.set(this.rootSessionID, snap);
      this.emit();
    });
    this.snapshots.set(this.rootSessionID, entry.controller.getState());
    this.tracked.set(this.rootSessionID, {
      controller: entry.controller,
      unwatch,
      info: null,
      key: entry.key,
      shared: true,
    });
  }

  /** Create a tree-private child controller: never shared, disposed with the tree. */
  private createChild(sessionID: string, info: TreeNode): void {
    const seam = muteScopeEvents(this.seamForSession(sessionID));
    const controller = new SessionMetricsController({
      serverID: this.serverID,
      sessionID,
      transport: seam,
      ...(this.pageLimit !== undefined ? { pageLimit: this.pageLimit } : {}),
      debounceMs: this.debounceMs,
    });
    const unwatch = controller.onUpdate((snap) => {
      this.snapshots.set(sessionID, snap);
      this.emit();
    });
    this.snapshots.set(sessionID, controller.getState());
    this.tracked.set(sessionID, { controller, unwatch, info, key: null, shared: false });
  }

  /**
   * Stop tracking one scope. Shared root entries are released back to the
   * cache without cancelling (other consumers keep them); private children
   * are disposed outright.
   */
  private releaseTracked(sessionID: string): void {
    const t = this.tracked.get(sessionID);
    if (!t) return;
    t.unwatch();
    if (t.shared && t.key !== null) releaseController(t.key);
    else t.controller.dispose();
    this.tracked.delete(sessionID);
    this.snapshots.delete(sessionID);
    this.live.remove(sessionID);
    if (!this.live.needsTick(this.clock())) this.stopLiveTimer();
  }

  /**
   * Full pass: the shared root is retained and queued before discovery is
   * awaited, so root metrics stream in while a slow tree walk still runs.
   * Discovery then reconciles children (private controllers), and every
   * tracked scope reloads through the bounded queue — ready, error and
   * empty alike — so manual refresh and reconnect recover useful scopes
   * even when discovery is slow or fails. Previously known children
   * survive a partial/failed discovery and are reported stale/partial
   * instead of vanishing silently.
   */
  async load(): Promise<void> {
    if (this.disposed) return;
    if (!this.isConnectedFn()) {
      this.treeStatus = "disconnected";
      this.stopLiveTimer();
      this.emit();
      return;
    }
    // Reconnect re-subscribes when disconnect invalidated the listener.
    this.attachTreeSubscription();
    const gen = ++this.generation;
    this.discoveryAbort?.abort();
    const aborter = new AbortController();
    this.discoveryAbort = aborter;
    const stale = () => gen !== this.generation || this.disposed || aborter.signal.aborted;
    this.treeStatus = "loading";
    this.emit();
    // Root first, without waiting for the tree walk and without an
    // immediate duplicate fetch: one queued load covers it. Bootstrap
    // already-running delegates from the same-server Data snapshot so a
    // header mounted after a busy event still follows without waiting.
    this.ensureRoot();
    this.bootstrapFromData();
    this.emit();
    this.ensureLiveTimer();
    this.enqueueScopeLoads([this.rootSessionID]);
    let nodes: TreeNode[];
    let discoveryPartial = false;
    try {
      const found = await discoverDescendants(this.rootSessionID, this.listPage, {
        ...(this.pageLimit !== undefined ? { pageLimit: this.pageLimit } : {}),
        ...(this.safetyPageCap !== undefined ? { safetyPageCap: this.safetyPageCap } : {}),
        ...(this.maxSessions !== undefined ? { maxSessions: this.maxSessions } : {}),
        signal: aborter.signal,
      });
      if (stale()) return;
      nodes = [...found.nodes];
      discoveryPartial = found.partial;
      this.treePartial = found.partial;
      this.treeError = found.error;
      this.treeErrorReason = found.errorReason ?? null;
    } catch (err) {
      if (stale()) return;
      // Discovery failure never erases known scopes: keep them and report
      // a partial, possibly stale tree. The root already has its queued
      // load from before discovery, so only the remaining scopes reload.
      // Verbatim third-party messages stay verbatim (reason null) under a
      // localized wrapper at presentation time.
      this.treeStatus = this.tracked.size > 0 ? "partial" : "error";
      this.treePartial = true;
      if (err instanceof Error) {
        this.treeError = err.message;
        this.treeErrorReason = null;
      } else {
        this.treeError = "could not discover subagents";
        this.treeErrorReason = { kind: "discovery-failed" };
      }
      this.emit();
      this.enqueueScopeLoads([...this.tracked.keys()].filter((id) => id !== this.rootSessionID));
      return;
    }
    if (stale()) return;
    if (!this.isConnectedFn()) {
      this.treeStatus = "disconnected";
      this.stopLiveTimer();
      this.emit();
      return;
    }

    const nodeById = new Map(nodes.map((n) => [n.info.id, n]));
    if (!discoveryPartial) {
      const wanted = new Set<string>([this.rootSessionID, ...nodes.map((n) => n.info.id)]);
      for (const sessionID of [...this.tracked.keys()]) {
        if (sessionID === this.rootSessionID) continue;
        if (!wanted.has(sessionID)) {
          this.releaseTracked(sessionID);
        } else {
          const t = this.tracked.get(sessionID);
          const node = nodeById.get(sessionID);
          if (t && node) t.info = node;
        }
      }
    } else {
      // Partial discovery: retain previously known children (possibly
      // stale) and only add newly verified nodes.
      for (const [sessionID, t] of this.tracked) {
        if (sessionID === this.rootSessionID) continue;
        const node = nodeById.get(sessionID);
        if (node) t.info = node;
      }
      for (const n of nodes) {
        if (!this.tracked.has(n.info.id)) nodeById.set(n.info.id, n);
      }
    }
    for (const n of nodeById.values()) {
      if (n.info.id === this.rootSessionID || this.tracked.has(n.info.id)) continue;
      this.createChild(n.info.id, n);
    }
    if (stale()) return;
    // Newly verified running children may have been outside the earlier
    // root-only live bootstrap; fill their waiting state without touching
    // the activity pending cache.
    this.bootstrapLiveFromData();
    this.emit();

    // Bounded reload of the remaining scopes: the root already has its
    // queued load from before discovery (re-queuing it here would fetch
    // it twice per pass), so only children are enqueued now. Refresh and
    // reconnect recover ready, error and empty scopes alike.
    // Already-running scopes are not restarted; event repeats stay coalesced.
    this.enqueueScopeLoads([...this.tracked.keys()].filter((id) => id !== this.rootSessionID));
    const drained = await this.awaitQueueDrained(gen);
    if (!drained || gen !== this.generation || this.disposed) return;
    this.finishPass();
  }

  private finishPass(): void {
    if (this.disposed) return;
    if (!this.isConnectedFn()) {
      this.treeStatus = "disconnected";
    } else {
      this.treeStatus = "ready";
    }
    this.emit();
  }

  private async awaitQueueDrained(gen: number): Promise<boolean> {
    for (;;) {
      if (gen !== this.generation || this.disposed) return false;
      if (this.loadQueue.length === 0 && this.activeLoads === 0) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * Disconnect immediately: real-cancel discovery, drop queued work,
   * invalidate the tree subscription (queued old-connection callbacks die
   * by token), clear stale delegate activity, and mark every owned scope
   * disconnected so stale scopes never render as current data. The shared
   * root controller is only marked disconnected, never disposed: sibling
   * consumers keep their entry and every consumer shares the same
   * same-server disconnected state. Late responses cannot overwrite it.
   * Stale delegate activity is cleared so the header falls back to the
   * root instead of a ghost worker.
   */
  markDisconnected(): void {
    if (this.disposed) return;
    this.cancel();
    this.activity.clear();
    this.live.clear();
    this.stopLiveTimer();
    this.detachTreeSubscription();
    for (const [, t] of this.tracked) {
      t.controller.markDisconnected();
    }
    this.treeStatus = "disconnected";
    this.emit();
  }

  /** Manual refresh and reconnect path: one bounded full pass. */
  refreshAll(): void {
    if (this.disposed) return;
    void this.load();
  }

  reconnect(): void {
    if (this.disposed) return;
    void this.load();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activity.clear();
    this.live.clear();
    this.stopLiveTimer();
    this.generation += 1;
    this.discoveryAbort?.abort();
    this.discoveryAbort = null;
    this.loadQueue = [];
    this.queuedIds.clear();
    this.inflightRuns.clear();
    this.repeatLoads.clear();
    this.activeLoads = 0;
    if (this.discoveryTimer !== null) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.pendingRefresh.clear();
    this.pendingDiscovery = false;
    this.detachTreeSubscription();
    for (const sessionID of [...this.tracked.keys()]) {
      this.releaseTracked(sessionID);
    }
    this.tracked.clear();
    this.snapshots.clear();
    this.listeners.clear();
  }
}
