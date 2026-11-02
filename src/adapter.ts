/**
 * Framework-free history/refresh adapter for TPSTracer.
 *
 * Reads paginated assistant history through a pinned transport seam (one
 * captured server connection; see transport.ts), dedupes by message ID, and
 * recomputes metrics only from completed message usage. Event payloads
 * (including streaming deltas) only trigger a bounded, coalesced reload:
 * delta chunks are never treated as tokens.
 *
 * Pagination runs to completion: every page is followed via the response
 * cursor, repeated cursors stop the walk, and each request is cancellable.
 * If the safety page cap is reached while pages remain, the snapshot reports
 * an explicit `partial` status — partial aggregates are never presented as
 * a complete session.
 */

import { collectObservations, collectSamples, summarize, type TpsObservation, type TpsSample, type TpsSummary } from "./metrics.js";
import { createEmptyAdapterSnapshot } from "./snapshots.js";
import type { DiagnosticReason } from "./definition.js";
import type { SessionMessageInfo } from "@opencode/client/promise";
import type { TransportSeam } from "./transport.js";

export type AdapterStatus = "idle" | "loading" | "ready" | "empty" | "partial" | "error" | "disconnected";

export interface AdapterSnapshot {
  readonly status: AdapterStatus;
  readonly samples: readonly TpsSample[];
  /** Minimal per-message observations, retained even when unmeasured/failed. */
  readonly observations: readonly TpsObservation[];
  readonly summary: TpsSummary;
  /** Human-readable note for `error` and `partial` states (verbatim third-party or legacy copy). */
  readonly error: string | null;
  /**
   * First-party reason as data for presentation-time localization.
   * Null for unknown third-party failures (see `error` verbatim).
   * Optional for backward compatibility with hand-built snapshots.
   */
  readonly reason?: DiagnosticReason | null;
}

export interface ControllerOptions {
  readonly serverID: string;
  readonly sessionID: string;
  readonly transport: TransportSeam;
  readonly pageLimit?: number;
  readonly safetyPageCap?: number;
  readonly debounceMs?: number;
}

export function sessionKey(serverID: string, sessionID: string): string {
  return `${serverID}\n${sessionID}`;
}

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_SAFETY_PAGE_CAP = 200;
const DEFAULT_DEBOUNCE_MS = 200;

export class SessionMetricsController {
  readonly serverID: string;
  readonly sessionID: string;
  readonly key: string;
  private transport: TransportSeam;
  private readonly pageLimit: number;
  private readonly safetyPageCap: number;
  private readonly debounceMs: number;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<(snap: AdapterSnapshot) => void>();
  private generation = 0;
  private inflight: AbortController | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private snapshot: AdapterSnapshot = createEmptyAdapterSnapshot();

  constructor(options: ControllerOptions) {
    this.serverID = options.serverID;
    this.sessionID = options.sessionID;
    this.key = sessionKey(options.serverID, options.sessionID);
    this.transport = options.transport;
    this.pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.safetyPageCap = options.safetyPageCap ?? DEFAULT_SAFETY_PAGE_CAP;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.attachSubscription();
  }

  private attachSubscription(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.transport.subscribe(() => this.requestRefresh());
  }

  /**
   * Renew the pinned connection (e.g. the server restarted with new
   * client/data objects). Re-subscribes and reloads only when the
   * connection identity actually changed; otherwise a no-op. Pass
   * `{ reload: false }` when the caller drives reloads through its own
   * bounded queue (session-tree children), so renewal never triggers an
   * unbounded immediate load per scope.
   *
   * Identity change always invalidates first: the previous generation is
   * cancelled so a late resolution from the old transport can never
   * publish, even when the caller defers the next load.
   */
  replaceTransport(next: TransportSeam, opts?: { readonly reload?: boolean }): boolean {
    if (this.disposed) return false;
    const prev = this.transport.refs;
    if (next.refs.client === prev.client && next.refs.data === prev.data) return false;
    this.cancel();
    this.transport = next;
    this.attachSubscription();
    if (opts?.reload === false) return true;
    void this.load();
    return true;
  }

  getState(): AdapterSnapshot {
    return this.snapshot;
  }

  onUpdate(listener: (snap: AdapterSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(next: AdapterSnapshot): void {
    this.snapshot = next;
    for (const l of [...this.listeners]) l(next);
  }

  /** Cancel any in-flight load; its late responses are dropped. */
  cancel(): void {
    this.generation += 1;
    this.inflight?.abort();
    this.inflight = null;
  }

  /**
   * Enter the disconnected state immediately: inflight work is cancelled so
   * a late response can never overwrite it with `ready`, and consumers show
   * disconnected even when no session event arrives.
   */
  markDisconnected(): void {
    if (this.disposed) return;
    this.cancel();
    this.emit({ ...createEmptyAdapterSnapshot(), status: "disconnected" });
  }

  /** Full paginated load with cycle detection and stale guards. */
  async load(): Promise<void> {
    if (this.disposed) return;
    if (!this.transport.isConnected()) {
      this.emit({ ...createEmptyAdapterSnapshot(), status: "disconnected" });
      return;
    }
    const transport = this.transport;
    const gen = ++this.generation;
    this.inflight?.abort();
    const aborter = new AbortController();
    this.inflight = aborter;
    this.emit({ status: "loading", samples: this.snapshot.samples, observations: this.snapshot.observations, summary: this.snapshot.summary, error: null });
    const stale = () => gen !== this.generation || this.disposed || aborter.signal.aborted;
    try {
      const seen = new Map<string, SessionMessageInfo>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      let complete = true;
      let stopReason: string | null = null;
      let stopCode: DiagnosticReason | null = null;
      for (;;) {
        if (aborter.signal.aborted) return;
        if (pages >= this.safetyPageCap) {
          complete = false;
          stopReason = `history truncated after ${pages} pages; session total incomplete`;
          stopCode = { kind: "history-truncated", pages };
          break;
        }
        const res = await transport.fetchPage({
          sessionID: this.sessionID,
          limit: this.pageLimit,
          ...(cursor !== undefined ? { cursor } : {}),
          signal: aborter.signal,
        });
        if (stale()) return;
        pages += 1;
        for (const m of res.data ?? []) {
          if (m && typeof m.id === "string" && !seen.has(m.id)) seen.set(m.id, m);
        }
        const next = res.cursor?.next ?? null;
        if (!next) break;
        if (seenCursors.has(next)) {
          complete = false;
          stopReason = "repeated history cursor; session total incomplete";
          stopCode = { kind: "repeated-cursor" };
          break;
        }
        seenCursors.add(next);
        cursor = next;
      }
      if (stale()) return;
      if (!transport.isConnected()) {
        this.emit({ ...createEmptyAdapterSnapshot(), status: "disconnected" });
        return;
      }
      const assistants = [...seen.values()].filter(
        (m): m is Extract<SessionMessageInfo, { type: "assistant" }> => m.type === "assistant",
      );
      const samples = collectSamples(assistants);
      const observations = collectObservations(assistants);
      const summary = summarize(samples, observations);
      if (stale()) return;
      if (!complete) {
        this.emit({ status: "partial", samples, observations, summary, error: stopReason, reason: stopCode });
      } else {
        this.emit({
          status: samples.length > 0 || summary.completedCount > 0 ? "ready" : "empty",
          samples,
          observations,
          summary,
          error: null,
          reason: null,
        });
      }
    } catch (err) {
      if (stale()) return;
      const message = err instanceof Error ? err.message : "history load failed";
      this.emit({ ...createEmptyAdapterSnapshot(), status: "error", error: message, reason: null });
    }
  }

  /** Coalesced reload request from any event (deltas included, never counted). */
  requestRefresh(): void {
    if (this.disposed) return;
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.load();
    }, this.debounceMs);
  }

  /** Reconnect path: drop coalesced work and take a fresh snapshot. */
  reconnect(): void {
    if (this.disposed) return;
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    void this.load();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.inflight?.abort();
    this.inflight = null;
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}
