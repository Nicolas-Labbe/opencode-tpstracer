/**
 * Verified delegate activity for the compact header.
 *
 * The header follows the most recently active verified same-server
 * descendant (never the root, never a fork, never an unrelated session)
 * whose independent liveness is busy/running/retry. Recency comes only
 * from same-server typed events with finite `created` timestamps and a
 * verified session id; work events (deltas, tool calls, step and shell
 * progress) may advance recency for an
 * already-working session but never prove liveness, tokens, or a rate.
 *
 * Ordering rules (all pure and unit-tested):
 * - Explicit status ordering (`statusCreated`) is tracked separately from
 *   recency (`lastActivity`), so a later delta can never make an older
 *   busy event outrank a newer idle.
 * - A newer idle supersedes an older busy; a delayed older event (busy or
 *   idle) cannot resurrect or suppress the newer explicit status, even when
 *   its recency timestamp is newer.
 * - Equal `created` timestamps are deterministic: idle wins (safe).
 * - Timestamp-free bootstrap (from `Data.session.active()`) never
 *   overwrites an explicit status event; it only fills entries without one.
 * - Malformed, non-finite, foreign, or unknown statuses are ignored.
 * - Busy includes tool/retry work: the header says "working", never
 *   "generating" or any provider-stream phase claim.
 * - Only IDs/status/timestamps/provenance are retained; no prompt,
 *   message, or token content is stored.
 */

import type { OpenCodeEvent } from "@opencode/client/promise";
import type { AdapterSnapshot } from "./adapter.js";

export type ActivityLiveness = "busy" | "retry" | "running" | "idle";

export interface ActivityEntry {
  readonly status: ActivityLiveness;
  /** Greatest explicit status `created` seen; null for bootstrap-only. */
  readonly statusCreated: number | null;
  /** Greatest valid activity timestamp; null for bootstrap-only. */
  readonly lastActivity: number | null;
}

/** Bounded pending/activity cache: prevents unbounded growth from event bursts. */
export const MAX_ACTIVITY_ENTRIES = 200;

function isFiniteCreated(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readSessionID(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  if (!("sessionID" in data)) return null;
  const id: unknown = (data as { sessionID?: unknown }).sessionID;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function readCreated(details: unknown): number | null {
  if (typeof details !== "object" || details === null) return null;
  if (!("created" in details)) return null;
  const created: unknown = (details as { created?: unknown }).created;
  return isFiniteCreated(created) ? created : null;
}

function readType(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  if (!("type" in details)) return null;
  const type: unknown = (details as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

/**
 * Parse a `session.status` liveness change. Returns null for malformed,
 * non-finite, foreign, or unknown statuses; never throws.
 */
export function readStatusActivity(details: OpenCodeEvent): {
  readonly sessionID: string;
  readonly liveness: "busy" | "retry" | "idle";
  readonly created: number;
} | null {
  if (readType(details) !== "session.status") return null;
  const created = readCreated(details);
  if (created === null) return null;
  if (typeof details !== "object" || details === null) return null;
  if (!("data" in details)) return null;
  const data: unknown = (details as { data?: unknown }).data;
  const sessionID = readSessionID(data);
  if (sessionID === null) return null;
  if (typeof data !== "object" || data === null) return null;
  if (!("status" in data)) return null;
  const status: unknown = (data as { status?: unknown }).status;
  if (typeof status !== "object" || status === null) return null;
  if (!("type" in status)) return null;
  const kind: unknown = (status as { type?: unknown }).type;
  if (kind !== "busy" && kind !== "retry" && kind !== "idle") return null;
  return { sessionID, liveness: kind, created };
}

/**
 * Parse a `session.idle` completion. Returns null for malformed or
 * non-finite events; never throws.
 */
export function readIdleActivity(details: OpenCodeEvent): {
  readonly sessionID: string;
  readonly created: number;
} | null {
  if (readType(details) !== "session.idle") return null;
  const created = readCreated(details);
  if (created === null) return null;
  if (typeof details !== "object" || details === null) return null;
  if (!("data" in details)) return null;
  const data: unknown = (details as { data?: unknown }).data;
  const sessionID = readSessionID(data);
  if (sessionID === null) return null;
  return { sessionID, created };
}

/**
 * In-progress work event types that may advance recency for an
 * independently known working session. Checked against the installed SDK
 * 2.2.0 union: every listed type carries `data.sessionID`. Completions,
 * failures, ends, and unrelated events are deliberately absent: a
 * response finishing must never advance activity.
 */
const WORK_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "session.text.delta",
  "session.reasoning.delta",
  "session.tool.input.delta",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.progress",
  "session.step.started",
  "session.step.streamed",
  "session.text.started",
  "session.reasoning.started",
  "session.shell.started",
  "session.execution.started",
  "session.retry.scheduled",
]);

/**
 * Parse a session work recency hint from the real SDK event union.
 *
 * Only whitelisted in-progress work types qualify: text/reasoning deltas,
 * tool input deltas/calls/progress, step start/stream markers, shell
 * start, execution start, and retry scheduling. Every candidate must carry
 * a verified `data.sessionID` plus a finite top-level `created`; all other
 * types (completions, failures, ends, deletions, metadata, unrelated
 * server events) yield null. Never proves liveness; never throws; no
 * payload is retained.
 */
export function readWorkActivity(details: OpenCodeEvent): {
  readonly sessionID: string;
  readonly created: number;
} | null {
  const type = readType(details);
  if (type === null || !WORK_ACTIVITY_TYPES.has(type)) return null;
  const created = readCreated(details);
  if (created === null) return null;
  if (typeof details !== "object" || details === null) return null;
  if (!("data" in details)) return null;
  const data: unknown = (details as { data?: unknown }).data;
  const sessionID = readSessionID(data);
  if (sessionID === null) return null;
  return { sessionID, created };
}

function isEligible(status: ActivityLiveness): boolean {
  return status === "busy" || status === "retry" || status === "running";
}

/**
 * Pure delegate selection over verified descendant ids.
 *
 * Among eligible (busy/running/retry) verified descendants, prefer the
 * greatest valid `lastActivity`; bootstrap-only entries (`lastActivity`
 * null) rank below any timestamped entry. Ties break by smallest
 * session id for determinism. The root is never in `verifiedIDs`, so a
 * busy root can never override an active descendant; an empty result
 * means the header falls back to the root.
 */
export function selectActiveDelegate(
  verifiedIDs: readonly string[],
  entries: ReadonlyMap<string, ActivityEntry>,
): string | null {
  let bestID: string | null = null;
  let bestActivity: number | null = null;
  for (const id of verifiedIDs) {
    if (typeof id !== "string" || id.length === 0) continue;
    const entry = entries.get(id);
    if (!entry || !isEligible(entry.status)) continue;
    const activity = entry.lastActivity;
    if (bestID === null) {
      bestID = id;
      bestActivity = activity;
      continue;
    }
    const current = bestActivity;
    // Null (bootstrap-only) always loses to a finite timestamp.
    if (activity === null && current === null) {
      if (id < bestID) {
        bestID = id;
        bestActivity = activity;
      }
      continue;
    }
    if (activity === null) continue;
    if (current === null) {
      bestID = id;
      bestActivity = activity;
      continue;
    }
    if (activity > current || (activity === current && id < bestID)) {
      bestID = id;
      bestActivity = activity;
    }
  }
  return bestID;
}

/**
 * Framework-free bounded activity tracker. All state is IDs, statuses,
 * and timestamps; no message or token content is retained.
 */
export class DelegateActivity {
  private readonly entries = new Map<string, ActivityEntry>();

  get size(): number {
    return this.entries.size;
  }

  get(sessionID: string): ActivityEntry | undefined {
    const entry = this.entries.get(sessionID);
    return entry === undefined ? undefined : { ...entry };
  }

  snapshot(): ReadonlyMap<string, ActivityEntry> {
    return new Map(this.entries);
  }

  clear(): void {
    this.entries.clear();
  }

  private evictIfNeeded(): void {
    while (this.entries.size >= MAX_ACTIVITY_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Timestamp-free bootstrap from `Data.session.active()`.
   *
   * Reconciles: entries without an explicit status that are no longer
   * reported running are dropped (stale bootstrap); entries with an
   * explicit status are never overwritten. Unknown/invalid ids ignored.
   */
  bootstrapRunning(ids: readonly string[]): void {
    const running = new Set<string>();
    for (const id of ids) {
      if (typeof id === "string" && id.length > 0) running.add(id);
    }
    for (const [id, entry] of [...this.entries]) {
      if (entry.statusCreated === null && entry.status === "running" && !running.has(id)) {
        this.entries.delete(id);
      }
    }
    for (const id of running) {
      const existing = this.entries.get(id);
      if (existing) {
        // Never overwrite an explicit status event with a timestamp-free guess.
        if (existing.statusCreated !== null) continue;
        if (existing.status === "running") continue;
        // A bootstrap-only idle entry (should not normally exist) yields to running.
        this.entries.set(id, { status: "running", statusCreated: null, lastActivity: existing.lastActivity });
        continue;
      }
      this.evictIfNeeded();
      this.entries.set(id, { status: "running", statusCreated: null, lastActivity: null });
    }
  }

  /**
   * Apply an explicit liveness change.
   *
   * Guards: non-finite `created`, empty ids, and unknown liveness are
   * ignored. An older `created` never overrides a newer explicit status,
   * even when its recency would be newer. Equal timestamps resolve safe:
   * idle wins over busy/retry. Idle is stored even for unknown sessions
   * as a bounded tombstone, so an idle observed before discovery or
   * bootstrap still suppresses a later older busy for the finished worker;
   * busy/retry for an unknown session creates a bounded pending entry that
   * only becomes selectable after discovery verifies the relationship.
   */
  onStatus(sessionID: string, liveness: ActivityLiveness, created: number): boolean {
    if (typeof sessionID !== "string" || sessionID.length === 0) return false;
    if (!isFiniteCreated(created)) return false;
    if (liveness !== "busy" && liveness !== "retry" && liveness !== "running" && liveness !== "idle") return false;
    const existing = this.entries.get(sessionID);
    if (!existing) {
      this.evictIfNeeded();
      if (liveness === "running") {
        this.entries.set(sessionID, { status: "running", statusCreated: null, lastActivity: null });
      } else if (liveness === "idle") {
        this.entries.set(sessionID, { status: "idle", statusCreated: created, lastActivity: null });
      } else {
        this.entries.set(sessionID, { status: liveness, statusCreated: created, lastActivity: created });
      }
      return true;
    }
    const prevCreated = existing.statusCreated;
    if (prevCreated !== null) {
      if (created < prevCreated) return false;
      if (created === prevCreated) {
        const prevIdle = existing.status === "idle";
        const nextIdle = liveness === "idle";
        if (prevIdle && !nextIdle) return false;
        if (!prevIdle && nextIdle) {
          this.entries.set(sessionID, { status: "idle", statusCreated: created, lastActivity: existing.lastActivity });
          return true;
        }
        if (prevIdle && nextIdle) return false;
        // Same working liveness at the same timestamp: keep earliest, no churn.
        return false;
      }
    }
    if (liveness === "idle") {
      this.entries.set(sessionID, { status: "idle", statusCreated: created, lastActivity: existing.lastActivity });
      return true;
    }
    const nextActivity =
      existing.lastActivity === null ? created : Math.max(existing.lastActivity, created);
    this.entries.set(sessionID, { status: liveness, statusCreated: created, lastActivity: nextActivity });
    return true;
  }

  /**
   * Advance recency from an in-progress work event (delta, tool call,
   * step/stream marker, shell start).
   *
   * Only for an independently known working session (busy/running/retry);
   * unknown and idle sessions are ignored, and status ordering is never
   * touched, so a later work event can never outrank an explicit idle.
   */
  onDelta(sessionID: string, created: number): boolean {
    if (typeof sessionID !== "string" || sessionID.length === 0) return false;
    if (!isFiniteCreated(created)) return false;
    const existing = this.entries.get(sessionID);
    if (!existing || !isEligible(existing.status)) return false;
    const prev = existing.lastActivity;
    if (prev !== null && created <= prev) return false;
    this.entries.set(sessionID, { ...existing, lastActivity: created });
    return true;
  }

  selectDelegate(verifiedIDs: readonly string[]): string | null {
    return selectActiveDelegate(verifiedIDs, this.entries);
  }
}

export interface HeaderTreeChild {
  readonly sessionID: string;
  readonly title: string | null;
  readonly agent: string | null;
  readonly snapshot: AdapterSnapshot;
}

export interface HeaderTreeLike {
  readonly rootSessionID: string;
  readonly root: AdapterSnapshot;
  readonly children: readonly HeaderTreeChild[];
}

export interface HeaderScopeSelection {
  readonly sessionID: string;
  readonly snap: AdapterSnapshot;
  readonly title: string | null;
  readonly agent: string | null;
  readonly isDelegate: boolean;
}

/**
 * Header scope policy: the verified active delegate's own snapshot when
 * known, otherwise the root's own snapshot. Never borrows another
 * scope's rate, an older measurement, or a wall-clock fallback; that
 * honesty is enforced downstream by `latestMeasurement` and
 * `headerBadgePresentation` over the returned `snap`.
 */
export function headerScopeForTree(
  tree: HeaderTreeLike,
  activeDelegateID: string | null | undefined,
): HeaderScopeSelection {
  if (typeof activeDelegateID === "string" && activeDelegateID.length > 0) {
    const child = tree.children.find((c) => c.sessionID === activeDelegateID);
    if (child) {
      return {
        sessionID: child.sessionID,
        snap: child.snapshot,
        title: child.title,
        agent: child.agent,
        isDelegate: true,
      };
    }
  }
  return { sessionID: tree.rootSessionID, snap: tree.root, title: null, agent: null, isDelegate: false };
}
