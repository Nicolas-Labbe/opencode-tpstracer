/**
 * Bounded, explicitly estimated live throughput and observed TTFT.
 *
 * This module is pure and framework-free. It consumes the installed SDK
 * 2.2.0 event union, retains only counts, identifiers and timestamps (never
 * streamed text), and fails closed on malformed or unknown payloads.
 *
 * Live throughput is a visible-output approximation:
 * - a three-second trailing window of observed text/reasoning/tool-input
 *   delta characters, estimated at four Unicode code points per token;
 * - the first nonempty chunk only establishes the observation start and is
 *   excluded from the rated numerator;
 * - at least two distinct local observation times and 500 ms are required;
 * - silence stays in the denominator and the estimate expires when no rated
 *   output remains in the window.
 *
 * TTFT is separate: it pairs a validated `session.step.started` host
 * timestamp with the first matching nonempty output event's host `created`
 * timestamp. Local monotonic time is used only for live arrival/elapsed
 * timing; host timestamps are never subtracted from local ones. Attaching
 * mid-step leaves TTFT and elapsed unknown instead of guessing.
 */

import type { OpenCodeEvent } from "@opencode/client/promise";

export type LivePhase = "idle" | "waiting" | "streaming" | "tool" | "retry" | "settling";

export interface LiveScopeSnapshot {
  readonly sessionID: string;
  readonly phase: LivePhase;
  /** Observed assistant message id; bounded identifier only. */
  readonly messageID: string | null;
  /** Host step-start timestamp when observed and valid; null for mid-step attach. */
  readonly stepStartedAt: number | null;
  /** Estimated visible-output tokens/s; null when not measurable, suppressed or expired. */
  readonly estimatedTps: number | null;
  /** Local observed elapsed since step start; null when start evidence is unavailable. */
  readonly elapsedMs: number | null;
  /** Latest observed TTFT with provenance; retained after completion. */
  readonly ttftMs: number | null;
  readonly ttftSource: "observed" | null;
  /** Explicit tool calls/progress still awaiting matching terminal events. */
  readonly activeTools: number;
  /** Provider-stream end observed for the current step. */
  readonly streamEnded: boolean;
  /** True while the scope has an active lifecycle state. */
  readonly active: boolean;
}

export interface LiveObservationResult {
  readonly changed: boolean;
  /** Lifecycle changes publish immediately; output deltas are throttled. */
  readonly immediate: boolean;
  readonly sessionID: string | null;
}

export type LiveEvent =
  | {
      readonly kind: "step-started";
      readonly sessionID: string;
      readonly messageID: string;
      readonly created: number;
      readonly startedHost: number | null;
      readonly eventID: string;
    }
  | {
      readonly kind: "output";
      readonly sessionID: string;
      readonly messageID: string;
      readonly created: number;
      readonly chars: number;
      readonly source: "text" | "reasoning" | "tool-input";
      readonly ordinal: number | null;
      readonly toolID: string | null;
      readonly eventID: string;
    }
  | {
      readonly kind: "stream-ended";
      readonly sessionID: string;
      readonly messageID: string;
      readonly created: number;
      readonly eventID: string;
    }
  | {
      readonly kind: "step-ended";
      readonly sessionID: string;
      readonly messageID: string;
      readonly created: number;
      readonly eventID: string;
    }
  | {
      readonly kind: "step-failed";
      readonly sessionID: string;
      readonly messageID: string;
      readonly created: number;
      readonly eventID: string;
    }
  | {
      readonly kind: "execution-started";
      readonly sessionID: string;
      readonly created: number;
      readonly eventID: string;
    }
  | {
      readonly kind: "execution-ended";
      readonly sessionID: string;
      readonly created: number;
      readonly eventID: string;
    }
  | {
      readonly kind: "execution-failed";
      readonly sessionID: string;
      readonly created: number;
      readonly eventID: string;
    }
  | {
      readonly kind: "status";
      readonly sessionID: string;
      readonly liveness: "busy" | "retry" | "idle";
      readonly created: number;
      readonly eventID: string;
    }
  | {
      readonly kind: "retry";
      readonly sessionID: string;
      readonly messageID: string | null;
      readonly created: number;
      readonly eventID: string;
    }
  | {
      readonly kind: "tool-started";
      readonly sessionID: string;
      readonly messageID: string;
      readonly toolID: string;
      readonly created: number;
      readonly eventID: string;
    }
  | {
      readonly kind: "tool-ended";
      readonly sessionID: string;
      readonly messageID: string;
      readonly toolID: string;
      readonly created: number;
      readonly eventID: string;
    };

export const LIVE_WINDOW_MS = 3000;
export const LIVE_BUCKET_MS = 100;
export const LIVE_MIN_SPAN_MS = 500;
export const LIVE_CHARS_PER_TOKEN = 4;
export const LIVE_MAX_SESSIONS = 200;
export const LIVE_MAX_BUCKETS = 40;
export const LIVE_MAX_TOOLS = 32;
export const LIVE_MAX_EVENT_IDS = 32;
const MAX_ID_LENGTH = 512;

interface LiveBucket {
  at: number;
  chars: number;
  ratedChars: number;
}

interface LiveState {
  sessionID: string;
  phase: LivePhase;
  messageID: string | null;
  stepStartedAt: number | null;
  stepObservedAt: number | null;
  ttftMs: number | null;
  ttftSource: "observed" | null;
  observationStart: number | null;
  lastRatedAt: number | null;
  lastOutputCreated: number | null;
  lastLifecycleCreated: number | null;
  lastStatusCreated: number | null;
  lastStatusKind: "busy" | "retry" | "idle" | null;
  seenEventIDs: string[];
  buckets: LiveBucket[];
  activeToolIDs: Set<string>;
  streamEnded: boolean;
  stepClosed: boolean;
  executionActive: boolean;
  bootstrapOnly: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readID(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null;
}

function readData(details: OpenCodeEvent): Record<string, unknown> | null {
  if (typeof details !== "object" || details === null) return null;
  const data: unknown = (details as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  return data as Record<string, unknown>;
}

function readBase(details: OpenCodeEvent): {
  readonly type: string;
  readonly created: number;
  readonly eventID: string;
} | null {
  if (typeof details !== "object" || details === null) return null;
  const type = (details as { type?: unknown }).type;
  const created = (details as { created?: unknown }).created;
  const eventID = readID((details as { id?: unknown }).id);
  if (typeof type !== "string" || !isFiniteNumber(created) || eventID === null) return null;
  return { type, created, eventID };
}

function readSessionID(data: Record<string, unknown>): string | null {
  return readID(data.sessionID);
}

function readMessageID(data: Record<string, unknown>): string | null {
  return readID(data.assistantMessageID);
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * Parse one whitelisted SDK event into a bounded live event. Unknown event
 * types, missing identities, non-finite timestamps and malformed payloads
 * return null; no payload text is retained beyond the derived character
 * count.
 */
export function readLiveEvent(details: OpenCodeEvent): LiveEvent | null {
  const base = readBase(details);
  if (base === null) return null;
  const data = readData(details);
  if (data === null) return null;
  const sessionID = readSessionID(data);
  if (sessionID === null) return null;

  switch (base.type) {
    case "session.step.started": {
      const messageID = readMessageID(data);
      if (messageID === null) return null;
      const started = data.started;
      const startedHost = isFiniteNumber(started) && started <= base.created ? started : null;
      return {
        kind: "step-started",
        sessionID,
        messageID,
        created: base.created,
        startedHost,
        eventID: base.eventID,
      };
    }
    case "session.step.streamed":
    case "session.step.ended":
    case "session.step.failed": {
      const messageID = readMessageID(data);
      if (messageID === null) return null;
      if (base.type === "session.step.streamed") {
        return { kind: "stream-ended", sessionID, messageID, created: base.created, eventID: base.eventID };
      }
      if (base.type === "session.step.ended") {
        return { kind: "step-ended", sessionID, messageID, created: base.created, eventID: base.eventID };
      }
      return { kind: "step-failed", sessionID, messageID, created: base.created, eventID: base.eventID };
    }
    case "session.execution.started":
      return { kind: "execution-started", sessionID, created: base.created, eventID: base.eventID };
    case "session.execution.succeeded":
      return { kind: "execution-ended", sessionID, created: base.created, eventID: base.eventID };
    case "session.execution.failed":
    case "session.execution.interrupted":
      return { kind: "execution-failed", sessionID, created: base.created, eventID: base.eventID };
    case "session.status": {
      const status = data.status;
      if (typeof status !== "object" || status === null) return null;
      const kind = (status as { type?: unknown }).type;
      if (kind !== "busy" && kind !== "retry" && kind !== "idle") return null;
      return { kind: "status", sessionID, liveness: kind, created: base.created, eventID: base.eventID };
    }
    case "session.idle":
      return { kind: "status", sessionID, liveness: "idle", created: base.created, eventID: base.eventID };
    case "session.retry.scheduled": {
      const messageID = readMessageID(data);
      return { kind: "retry", sessionID, messageID, created: base.created, eventID: base.eventID };
    }
    case "session.text.delta":
    case "session.reasoning.delta": {
      const messageID = readMessageID(data);
      const delta = data.delta;
      const ordinal = data.ordinal;
      if (messageID === null || typeof delta !== "string" || !isFiniteNumber(ordinal)) return null;
      const chars = codePointLength(delta);
      if (chars === 0) return null;
      return {
        kind: "output",
        sessionID,
        messageID,
        created: base.created,
        chars,
        source: base.type === "session.text.delta" ? "text" : "reasoning",
        ordinal,
        toolID: null,
        eventID: base.eventID,
      };
    }
    case "session.tool.input.delta": {
      const messageID = readMessageID(data);
      const delta = data.delta;
      const toolID = readID(data.id);
      if (messageID === null || typeof delta !== "string" || toolID === null) return null;
      const chars = codePointLength(delta);
      if (chars === 0) return null;
      return {
        kind: "output",
        sessionID,
        messageID,
        created: base.created,
        chars,
        source: "tool-input",
        ordinal: null,
        toolID,
        eventID: base.eventID,
      };
    }
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed": {
      const messageID = readMessageID(data);
      const toolID = readID(data.id);
      if (messageID === null || toolID === null) return null;
      if (base.type === "session.tool.success" || base.type === "session.tool.failed") {
        return { kind: "tool-ended", sessionID, messageID, toolID, created: base.created, eventID: base.eventID };
      }
      return { kind: "tool-started", sessionID, messageID, toolID, created: base.created, eventID: base.eventID };
    }
    default:
      return null;
  }
}

function newState(sessionID: string): LiveState {
  return {
    sessionID,
    phase: "idle",
    messageID: null,
    stepStartedAt: null,
    stepObservedAt: null,
    ttftMs: null,
    ttftSource: null,
    observationStart: null,
    lastRatedAt: null,
    lastOutputCreated: null,
    lastLifecycleCreated: null,
    lastStatusCreated: null,
    lastStatusKind: null,
    seenEventIDs: [],
    buckets: [],
    activeToolIDs: new Set(),
    streamEnded: false,
    stepClosed: false,
    executionActive: false,
    bootstrapOnly: false,
  };
}

function clearWindow(state: LiveState): void {
  state.buckets = [];
  state.observationStart = null;
  state.lastRatedAt = null;
}

function clearTools(state: LiveState): void {
  state.activeToolIDs.clear();
}

function staleOutput(state: LiveState, created: number): boolean {
  return state.lastOutputCreated !== null && created < state.lastOutputCreated;
}

function resetStep(
  state: LiveState,
  messageID: string | null,
  startedHost: number | null,
  observedAt: number | null,
): void {
  state.messageID = messageID;
  state.stepStartedAt = startedHost;
  state.stepObservedAt = observedAt;
  state.ttftMs = null;
  state.ttftSource = null;
  clearWindow(state);
  clearTools(state);
  state.streamEnded = false;
  state.stepClosed = false;
  state.lastOutputCreated = null;
  state.phase = "waiting";
  state.executionActive = true;
  state.bootstrapOnly = false;
}

function resetExecution(state: LiveState): void {
  resetStep(state, null, null, null);
}

function addBucket(state: LiveState, at: number, chars: number, rated: boolean): void {
  const last = state.buckets[state.buckets.length - 1];
  if (last && at - last.at < LIVE_BUCKET_MS && at >= last.at) {
    last.chars += chars;
    if (rated) last.ratedChars += chars;
  } else {
    state.buckets.push({ at, chars, ratedChars: rated ? chars : 0 });
  }
  if (state.buckets.length > LIVE_MAX_BUCKETS) state.buckets.shift();
}

function pruneBuckets(state: LiveState, now: number): void {
  const cutoff = now - LIVE_WINDOW_MS - LIVE_BUCKET_MS;
  while (state.buckets.length > 0 && state.buckets[0]!.at < cutoff) state.buckets.shift();
}

function ratedCharsInWindow(state: LiveState, now: number): number {
  const start = now - LIVE_WINDOW_MS;
  let total = 0;
  for (const bucket of state.buckets) {
    if (bucket.at >= start) total += bucket.ratedChars;
  }
  return total;
}

function estimatedTpsFor(state: LiveState, now: number): number | null {
  if (state.phase !== "streaming" || state.streamEnded || state.activeToolIDs.size > 0) return null;
  if (state.observationStart === null || state.lastRatedAt === null) return null;
  if (state.lastRatedAt <= state.observationStart) return null;
  if (now - state.observationStart < LIVE_MIN_SPAN_MS) return null;
  const rated = ratedCharsInWindow(state, now);
  if (rated <= 0) return null;
  const denominatorMs = Math.min(LIVE_WINDOW_MS, now - state.observationStart);
  if (denominatorMs < LIVE_MIN_SPAN_MS) return null;
  return rated / LIVE_CHARS_PER_TOKEN / (denominatorMs / 1000);
}

function snapshotFor(state: LiveState, now: number): LiveScopeSnapshot {
  const elapsed =
    state.phase !== "idle" && state.stepObservedAt !== null && now >= state.stepObservedAt
      ? now - state.stepObservedAt
      : null;
  return {
    sessionID: state.sessionID,
    phase: state.phase,
    messageID: state.messageID,
    stepStartedAt: state.stepStartedAt,
    estimatedTps: estimatedTpsFor(state, now),
    elapsedMs: elapsed,
    ttftMs: state.ttftMs,
    ttftSource: state.ttftSource,
    activeTools: state.activeToolIDs.size,
    streamEnded: state.streamEnded,
    active: state.phase !== "idle",
  };
}

function eventSeen(state: LiveState, eventID: string): boolean {
  return state.seenEventIDs.includes(eventID);
}

function rememberEvent(state: LiveState, eventID: string): void {
  state.seenEventIDs.push(eventID);
  if (state.seenEventIDs.length > LIVE_MAX_EVENT_IDS) state.seenEventIDs.shift();
}

/**
 * Framework-free bounded live tracker. One instance per shared tree. All
 * state is identifiers, counts, statuses and timestamps; streamed text is
 * converted to a code-point count and discarded.
 */
export class LiveTracker {
  private readonly entries = new Map<string, LiveState>();

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  remove(sessionID: string): void {
    this.entries.delete(sessionID);
  }

  private evictIfNeeded(): void {
    while (this.entries.size >= LIVE_MAX_SESSIONS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }

  private ensure(sessionID: string): LiveState {
    const existing = this.entries.get(sessionID);
    if (existing) return existing;
    this.evictIfNeeded();
    const state = newState(sessionID);
    this.entries.set(sessionID, state);
    return state;
  }

  /**
   * Bootstrap timestamp-free running sessions. Explicit statuses are never
   * overwritten; bootstrap-only states disappear when the running set no
   * longer reports them. This only fills activity knowledge: elapsed and
   * TTFT stay unknown because no step start was observed.
   */
  bootstrapRunning(ids: readonly string[]): boolean {
    const running = new Set<string>();
    for (const id of ids) {
      const valid = readID(id);
      if (valid !== null) running.add(valid);
    }
    let changed = false;
    for (const [id, state] of [...this.entries]) {
      if (state.bootstrapOnly && !running.has(id)) {
        this.entries.delete(id);
        changed = true;
      }
    }
    for (const id of running) {
      if (this.entries.has(id)) continue;
      this.evictIfNeeded();
      const state = newState(id);
      state.phase = "waiting";
      state.bootstrapOnly = true;
      this.entries.set(id, state);
      changed = true;
    }
    return changed;
  }

  private onStepStarted(
    state: LiveState,
    event: Extract<LiveEvent, { kind: "step-started" }>,
    now: number,
  ): boolean {
    if (state.lastLifecycleCreated !== null && event.created < state.lastLifecycleCreated) return false;
    if (staleOutput(state, event.created)) return false;
    if (
      state.messageID === event.messageID &&
      state.stepStartedAt === event.startedHost &&
      state.stepObservedAt !== null
    ) {
      return false;
    }
    resetStep(state, event.messageID, event.startedHost, now);
    state.lastLifecycleCreated = event.created;
    return true;
  }

  private onExecutionStarted(state: LiveState, event: Extract<LiveEvent, { kind: "execution-started" }>): boolean {
    if (state.lastLifecycleCreated !== null && event.created < state.lastLifecycleCreated) return false;
    if (staleOutput(state, event.created)) return false;
    state.lastLifecycleCreated = event.created;
    if (state.phase === "idle" || state.phase === "settling" || state.phase === "retry") {
      resetExecution(state);
      return true;
    }
    if (!state.executionActive) {
      state.executionActive = true;
      return true;
    }
    return false;
  }

  private onExecutionEnded(
    state: LiveState,
    event: Extract<LiveEvent, { kind: "execution-ended" | "execution-failed" }>,
  ): boolean {
    if (state.lastLifecycleCreated !== null && event.created < state.lastLifecycleCreated) return false;
    if (staleOutput(state, event.created)) return false;
    state.lastLifecycleCreated = event.created;
    if (state.phase === "idle" && !state.executionActive && state.activeToolIDs.size === 0) return false;
    state.phase = "idle";
    state.executionActive = false;
    state.streamEnded = false;
    state.stepClosed = true;
    state.stepStartedAt = null;
    state.stepObservedAt = null;
    clearWindow(state);
    clearTools(state);
    return true;
  }

  private onStatus(
    state: LiveState,
    event: Extract<LiveEvent, { kind: "status" }>,
  ): boolean {
    if (state.lastLifecycleCreated !== null && event.created < state.lastLifecycleCreated) return false;
    if (staleOutput(state, event.created)) return false;
    if (state.lastStatusCreated !== null) {
      if (event.created < state.lastStatusCreated) return false;
      if (event.created === state.lastStatusCreated) {
        if (state.lastStatusKind === "idle") return false;
        if (event.liveness !== "idle") return false;
      }
    }
    state.lastStatusCreated = event.created;
    state.lastStatusKind = event.liveness;
    state.lastLifecycleCreated = event.created;
    if (event.liveness === "idle") {
      const wasIdle =
        state.phase === "idle" && !state.executionActive && state.activeToolIDs.size === 0 && state.stepClosed;
      state.phase = "idle";
      state.executionActive = false;
      state.streamEnded = false;
      state.stepClosed = true;
      state.stepStartedAt = null;
      state.stepObservedAt = null;
      clearWindow(state);
      clearTools(state);
      return !wasIdle;
    }
    if (event.liveness === "retry") {
      state.phase = "retry";
      state.executionActive = true;
      state.streamEnded = false;
      state.stepClosed = false;
      state.stepStartedAt = null;
      state.stepObservedAt = null;
      state.ttftMs = null;
      state.ttftSource = null;
      clearWindow(state);
      clearTools(state);
      return true;
    }
    if (state.phase === "idle" || state.phase === "settling" || state.phase === "retry") {
      resetExecution(state);
      return true;
    }
    if (!state.executionActive) {
      state.executionActive = true;
      return true;
    }
    return false;
  }

  private onStreamEnded(
    state: LiveState,
    event: Extract<LiveEvent, { kind: "stream-ended" }>,
  ): boolean {
    if (state.lastLifecycleCreated !== null && event.created < state.lastLifecycleCreated) return false;
    if (staleOutput(state, event.created)) return false;
    if (state.messageID !== null && state.messageID !== event.messageID) return false;
    if (state.streamEnded) return false;
    state.messageID = state.messageID ?? event.messageID;
    state.streamEnded = true;
    state.phase = state.activeToolIDs.size > 0 ? "tool" : "settling";
    state.executionActive = true;
    clearWindow(state);
    state.lastLifecycleCreated = event.created;
    return true;
  }

  private onStepEnded(
    state: LiveState,
    event: Extract<LiveEvent, { kind: "step-ended" | "step-failed" }>,
  ): boolean {
    if (state.lastLifecycleCreated !== null && event.created < state.lastLifecycleCreated) return false;
    if (staleOutput(state, event.created)) return false;
    if (state.messageID !== null && state.messageID !== event.messageID) return false;
    state.lastLifecycleCreated = event.created;
    state.streamEnded = false;
    state.stepClosed = true;
    state.stepStartedAt = null;
    clearWindow(state);
    if (event.kind === "step-failed") {
      state.phase = "idle";
      state.executionActive = false;
      state.stepObservedAt = null;
      clearTools(state);
      return true;
    }
    if (state.activeToolIDs.size > 0) {
      state.phase = "tool";
    } else if (state.executionActive) {
      state.phase = "waiting";
    } else {
      state.phase = "idle";
    }
    return true;
  }

  private onRetry(state: LiveState, event: Extract<LiveEvent, { kind: "retry" }>): boolean {
    if (state.lastLifecycleCreated !== null && event.created < state.lastLifecycleCreated) return false;
    if (staleOutput(state, event.created)) return false;
    state.lastLifecycleCreated = event.created;
    if (event.messageID !== null) state.messageID = event.messageID;
    state.phase = "retry";
    state.executionActive = true;
    state.streamEnded = false;
    state.stepClosed = false;
    state.stepStartedAt = null;
    state.stepObservedAt = null;
    state.ttftMs = null;
    state.ttftSource = null;
    clearWindow(state);
    clearTools(state);
    state.bootstrapOnly = false;
    return true;
  }

  private onToolStarted(
    state: LiveState,
    event: Extract<LiveEvent, { kind: "tool-started" }>,
  ): boolean {
    if (state.lastLifecycleCreated !== null && event.created < state.lastLifecycleCreated) return false;
    if (staleOutput(state, event.created)) return false;
    if (state.phase === "idle") {
      if (state.messageID !== null && state.messageID === event.messageID) return false;
      resetStep(state, event.messageID, null, null);
      state.phase = "tool";
      state.executionActive = true;
      state.lastLifecycleCreated = event.created;
      state.activeToolIDs.add(event.toolID);
      return true;
    }
    if (state.messageID !== null && state.messageID !== event.messageID) return false;
    state.lastLifecycleCreated = event.created;
    state.messageID = state.messageID ?? event.messageID;
    state.executionActive = true;
    const already = state.activeToolIDs.has(event.toolID);
    if (!already) {
      if (state.activeToolIDs.size >= LIVE_MAX_TOOLS) return false;
      state.activeToolIDs.add(event.toolID);
    }
    if (state.phase !== "tool") {
      clearWindow(state);
      state.phase = "tool";
      return true;
    }
    return !already;
  }

  private onToolEnded(
    state: LiveState,
    event: Extract<LiveEvent, { kind: "tool-ended" }>,
  ): boolean {
    if (state.lastLifecycleCreated !== null && event.created < state.lastLifecycleCreated) return false;
    if (staleOutput(state, event.created)) return false;
    if (state.messageID !== null && state.messageID !== event.messageID) return false;
    if (!state.activeToolIDs.has(event.toolID)) return false;
    state.lastLifecycleCreated = event.created;
    state.activeToolIDs.delete(event.toolID);
    if (state.activeToolIDs.size > 0) return true;
    if (state.streamEnded) {
      state.phase = "settling";
    } else if (state.executionActive) {
      state.phase = "waiting";
    } else {
      state.phase = "idle";
    }
    return true;
  }

  private onOutput(state: LiveState, event: Extract<LiveEvent, { kind: "output" }>, now: number): boolean {
    if (state.lastLifecycleCreated !== null && event.created < state.lastLifecycleCreated) return false;
    if (staleOutput(state, event.created)) return false;
    if (state.streamEnded || state.phase === "retry" || state.phase === "settling" || state.phase === "tool") {
      return false;
    }
    if (state.stepClosed) {
      if (state.phase !== "idle" || state.messageID === event.messageID) return false;
    }
    if (state.phase === "idle") {
      if (state.messageID !== null && state.messageID === event.messageID) return false;
      resetStep(state, event.messageID, null, null);
      state.phase = "streaming";
      state.executionActive = true;
    }
    if (state.messageID === null) {
      resetStep(state, event.messageID, null, null);
      state.phase = "streaming";
      state.executionActive = true;
    }
    if (state.messageID !== event.messageID) return false;
    if (state.lastOutputCreated !== null && event.created < state.lastOutputCreated) return false;
    if (eventSeen(state, event.eventID)) return false;
    if (state.stepStartedAt !== null && event.created < state.stepStartedAt) return false;

    const seed = state.observationStart === null;
    if (seed) {
      state.observationStart = now;
      if (state.stepStartedAt !== null && state.ttftMs === null && event.created >= state.stepStartedAt) {
        state.ttftMs = event.created - state.stepStartedAt;
        state.ttftSource = "observed";
      }
    } else {
      state.lastRatedAt = now;
    }
    state.lastOutputCreated = event.created;
    rememberEvent(state, event.eventID);
    addBucket(state, now, event.chars, !seed);
    state.phase = "streaming";
    state.bootstrapOnly = false;
    return true;
  }

  /** Apply one SDK event. Never throws; unknown or invalid payloads fail closed. */
  observe(details: OpenCodeEvent, now: number): LiveObservationResult {
    if (!isFiniteNumber(now)) return { changed: false, immediate: false, sessionID: null };
    let event: LiveEvent | null = null;
    try {
      event = readLiveEvent(details);
    } catch {
      return { changed: false, immediate: false, sessionID: null };
    }
    if (event === null) return { changed: false, immediate: false, sessionID: null };
    const state = this.ensure(event.sessionID);
    let changed = false;
    switch (event.kind) {
      case "step-started":
        changed = this.onStepStarted(state, event, now);
        break;
      case "output":
        changed = this.onOutput(state, event, now);
        break;
      case "stream-ended":
        changed = this.onStreamEnded(state, event);
        break;
      case "step-ended":
      case "step-failed":
        changed = this.onStepEnded(state, event);
        break;
      case "execution-started":
        changed = this.onExecutionStarted(state, event);
        break;
      case "execution-ended":
      case "execution-failed":
        changed = this.onExecutionEnded(state, event);
        break;
      case "status":
        changed = this.onStatus(state, event);
        break;
      case "retry":
        changed = this.onRetry(state, event);
        break;
      case "tool-started":
        changed = this.onToolStarted(state, event);
        break;
      case "tool-ended":
        changed = this.onToolEnded(state, event);
        break;
    }
    return { changed, immediate: event.kind !== "output", sessionID: event.sessionID };
  }

  /** Immutable bounded snapshots for the requested tracked scopes only. */
  snapshot(sessionIDs: Iterable<string>, now: number): LiveScopeSnapshot[] {
    const out: LiveScopeSnapshot[] = [];
    for (const sessionID of sessionIDs) {
      const state = this.entries.get(sessionID);
      if (state) out.push(snapshotFor(state, now));
    }
    return out;
  }

  /** True while elapsed/rate timing can still change; drives the tree's only live timer. */
  needsTick(now: number): boolean {
    if (!isFiniteNumber(now)) return false;
    for (const state of this.entries.values()) {
      if (state.phase === "streaming") {
        if (state.stepObservedAt !== null) return true;
        if (state.observationStart !== null) {
          if (now - state.observationStart < LIVE_WINDOW_MS + LIVE_BUCKET_MS) return true;
          if (ratedCharsInWindow(state, now) > 0) return true;
        }
      } else if (
        (state.phase === "waiting" || state.phase === "tool") &&
        state.stepObservedAt !== null
      ) {
        return true;
      }
    }
    return false;
  }

  /** Drop expired buckets. Timer ticks never fetch or discover anything. */
  tick(now: number): void {
    if (!isFiniteNumber(now)) return;
    for (const state of this.entries.values()) pruneBuckets(state, now);
  }
}
