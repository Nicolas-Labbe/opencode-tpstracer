import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type {
  OpenCodeEvent,
  SessionInfo,
  SessionMessagesResponse,
  SessionsResponse,
} from "@opencode/client/promise";
import {
  LIVE_CHARS_PER_TOKEN,
  LIVE_MAX_SESSIONS,
  LIVE_WINDOW_MS,
  LiveTracker,
  type LiveScopeSnapshot,
} from "../src/live.js";
import {
  formatTtft,
  headerBadgePresentation,
  liveRowPresentation,
  liveSnapshotFor,
  sessionFinalRate,
} from "../src/presentation.js";
import { headerScopeForTree } from "../src/activity.js";
import { SessionTreeController, type TreeSnapshot } from "../src/orchestrator.js";
import type { FetchPage, TransportSeam } from "../src/transport.js";
import { liveEstimateFromStoreValue, t } from "../src/i18n.js";
import { normalizeLiveEstimate } from "../src/definition.js";

const durable = { aggregateID: "a", seq: 1, version: 1 } as const;

function event(id: string, type: string, created: number, data: Record<string, unknown>): OpenCodeEvent {
  return { id, created, type, durable, data } as unknown as OpenCodeEvent;
}

function stepStarted(
  sessionID: string,
  messageID: string,
  created: number,
  started: number | null = created,
): OpenCodeEvent {
  return event(`step-${sessionID}-${messageID}-${created}`, "session.step.started", created, {
    sessionID,
    assistantMessageID: messageID,
    agent: "build",
    model: { providerID: "acme", id: "fast" },
    ...(started !== null ? { started } : {}),
  });
}

function delta(
  sessionID: string,
  messageID: string,
  created: number,
  text: string,
  ordinal = 0,
  type: "session.text.delta" | "session.reasoning.delta" = "session.text.delta",
): OpenCodeEvent {
  return event(`delta-${sessionID}-${messageID}-${created}-${ordinal}-${type}`, type, created, {
    sessionID,
    assistantMessageID: messageID,
    ordinal,
    delta: text,
  });
}

function toolInputDelta(
  sessionID: string,
  messageID: string,
  created: number,
  text: string,
  toolID = "t1",
): OpenCodeEvent {
  return event(`tool-delta-${sessionID}-${messageID}-${created}-${toolID}`, "session.tool.input.delta", created, {
    sessionID,
    assistantMessageID: messageID,
    id: toolID,
    delta: text,
  });
}

function streamed(sessionID: string, messageID: string, created: number): OpenCodeEvent {
  return event(`streamed-${sessionID}-${messageID}-${created}`, "session.step.streamed", created, {
    sessionID,
    assistantMessageID: messageID,
  });
}

function stepEnded(sessionID: string, messageID: string, created: number, failed = false): OpenCodeEvent {
  return event(`ended-${sessionID}-${messageID}-${created}`, failed ? "session.step.failed" : "session.step.ended", created, {
    sessionID,
    assistantMessageID: messageID,
    finish: failed ? "error" : "stop",
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  });
}

function executionStarted(sessionID: string, created: number): OpenCodeEvent {
  return event(`exec-${sessionID}-${created}`, "session.execution.started", created, { sessionID });
}

function executionEnded(sessionID: string, created: number): OpenCodeEvent {
  return event(`exec-end-${sessionID}-${created}`, "session.execution.succeeded", created, { sessionID });
}

function executionFailed(sessionID: string, created: number): OpenCodeEvent {
  return event(`exec-fail-${sessionID}-${created}`, "session.execution.failed", created, {
    sessionID,
    error: { type: "unknown", message: "failed" },
  });
}

function statusEvent(
  sessionID: string,
  kind: "busy" | "retry" | "idle",
  created: number,
): OpenCodeEvent {
  const status =
    kind === "busy"
      ? { type: "busy" }
      : kind === "retry"
        ? { type: "retry", attempt: 1, message: "wait", next: created + 1000 }
        : { type: "idle" };
  return event(`status-${sessionID}-${created}`, "session.status", created, { sessionID, status });
}

function toolCalled(sessionID: string, messageID: string, created: number, toolID: string): OpenCodeEvent {
  return event(`tool-${sessionID}-${toolID}-${created}`, "session.tool.called", created, {
    sessionID,
    assistantMessageID: messageID,
    id: toolID,
    input: {},
    executed: true,
  });
}

function toolSuccess(sessionID: string, messageID: string, created: number, toolID: string): OpenCodeEvent {
  return event(`tool-ok-${sessionID}-${toolID}-${created}`, "session.tool.success", created, {
    sessionID,
    assistantMessageID: messageID,
    id: toolID,
    content: [{ type: "text", text: "result" }],
    executed: true,
  });
}

function retry(sessionID: string, messageID: string, created: number): OpenCodeEvent {
  return event(`retry-${sessionID}-${messageID}-${created}`, "session.retry.scheduled", created, {
    sessionID,
    assistantMessageID: messageID,
    attempt: 1,
    at: created + 1000,
    error: { type: "unknown", message: "retry" },
  });
}

function liveAt(tracker: LiveTracker, now: number, sessionID = "s1"): LiveScopeSnapshot | null {
  return tracker.snapshot([sessionID], now)[0] ?? null;
}

function summaryWithFinal(rate = 50) {
  return {
    last: {
      id: "m1",
      agent: "build",
      model: "acme/A",
      output: 100,
      reasoning: 0,
      created: 0,
      streamed: 1000,
      completed: 2000,
      durationMs: 2000,
      activeDurationMs: 1000,
      generated: 100,
      tps: rate,
      wallTps: rate,
      primaryTps: rate,
    },
    lastCompleted: { id: "m1", model: "acme/A", completed: 2000 },
    completedCount: 1,
    weightedPrimaryTps: rate,
  } as never;
}

const emptySummary = { last: null, lastCompleted: null, completedCount: 0, weightedPrimaryTps: 0 } as never;

describe("live estimate arithmetic", () => {
  it("excludes the first chunk, requires two timestamps, and follows a trailing window", () => {
    const tracker = new LiveTracker();
    tracker.observe(stepStarted("s1", "m1", 1000, 1000), 0);
    expect(liveAt(tracker, 0)).toMatchObject({ phase: "waiting", estimatedTps: null, ttftMs: null });

    tracker.observe(delta("s1", "m1", 1500, "a".repeat(40), 0), 0);
    expect(liveAt(tracker, 0)?.estimatedTps).toBeNull();

    tracker.observe(delta("s1", "m1", 2500, "b".repeat(40), 1), 1000);
    const measured = liveAt(tracker, 1000);
    expect(measured?.estimatedTps).toBeCloseTo(10);
    expect(measured?.ttftMs).toBe(500);
    expect(measured?.phase).toBe("streaming");
    expect(measured?.active).toBe(true);

    // Silence stays in the denominator: the same rated output over 2s.
    expect(liveAt(tracker, 2000)?.estimatedTps).toBeCloseTo(5);
    // At the trailing-window edge it is still measured; just after, it expires.
    expect(liveAt(tracker, 4000)?.estimatedTps).toBeCloseTo(10 / 3);
    expect(liveAt(tracker, 4001)?.estimatedTps).toBeNull();
  });

  it("does not rate a single burst or a span shorter than 500 ms", () => {
    const burst = new LiveTracker();
    burst.observe(delta("s1", "m1", 1000, "a".repeat(40), 0), 0);
    burst.observe(delta("s1", "m1", 1000, "b".repeat(40), 1), 0);
    expect(liveAt(burst, 1000)?.estimatedTps).toBeNull();

    const shortSpan = new LiveTracker();
    shortSpan.observe(delta("s1", "m1", 1000, "a", 0), 0);
    shortSpan.observe(delta("s1", "m1", 1400, "b".repeat(20), 1), 400);
    expect(liveAt(shortSpan, 400)?.estimatedTps).toBeNull();
    // At 500 ms the same observed output becomes measurable.
    expect(liveAt(shortSpan, 500)?.estimatedTps).toBeCloseTo(10);
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    const tracker = new LiveTracker();
    tracker.observe(delta("s1", "m1", 1000, "a", 0), 0);
    tracker.observe(delta("s1", "m1", 1500, "😀😀😀😀", 1), 500);
    // Four emoji = one estimated token over 0.5 s = 2 tokens/s.
    expect(liveAt(tracker, 500)?.estimatedTps).toBeCloseTo(2);
    expect(LIVE_CHARS_PER_TOKEN).toBe(4);
  });

  it("expires without start evidence and stops needing ticks", () => {
    const tracker = new LiveTracker();
    tracker.observe(delta("s1", "m1", 1000, "a", 0), 0);
    tracker.observe(delta("s1", "m1", 2000, "b".repeat(40), 1), 1000);
    expect(liveAt(tracker, 1000)?.estimatedTps).toBeCloseTo(10);
    expect(tracker.needsTick(2000)).toBe(true);
    expect(liveAt(tracker, 4001)?.estimatedTps).toBeNull();
    expect(tracker.needsTick(4001)).toBe(false);
    expect(LIVE_WINDOW_MS).toBe(3000);
  });

  it("counts incremental tool-input deltas but not full tool payloads", () => {
    const tracker = new LiveTracker();
    tracker.observe(delta("s1", "m1", 1000, "a", 0), 0);
    tracker.observe(toolInputDelta("s1", "m1", 2000, "b".repeat(40)), 1000);
    expect(liveAt(tracker, 1000)?.estimatedTps).toBeCloseTo(10);
    tracker.observe(
      event("tool-full", "session.tool.input.ended", 2100, {
        sessionID: "s1",
        assistantMessageID: "m1",
        id: "t1",
        text: "x".repeat(4000),
      }),
      1100,
    );
    expect(liveAt(tracker, 2000)?.estimatedTps).toBeCloseTo(5);
  });
});

describe("live lifecycle, TTFT and tools", () => {
  it("matches TTFT only for a matching step and nonempty output", () => {
    const tracker = new LiveTracker();
    tracker.observe(stepStarted("s1", "m1", 1000, 1000), 0);
    tracker.observe(
      event("text-started", "session.text.started", 1100, {
        sessionID: "s1",
        assistantMessageID: "m1",
        ordinal: 0,
      }),
      100,
    );
    expect(liveAt(tracker, 100)?.ttftMs).toBeNull();
    tracker.observe(delta("s1", "m1", 1800, "hello", 0), 800);
    expect(liveAt(tracker, 800)?.ttftMs).toBe(800);
    expect(liveAt(tracker, 800)?.ttftSource).toBe("observed");
  });

  it("resets TTFT on a new step, keeps it after completion, and never invents mid-step TTFT", () => {
    const tracker = new LiveTracker();
    tracker.observe(stepStarted("s1", "m1", 1000, 1000), 0);
    tracker.observe(delta("s1", "m1", 1800, "hello", 0), 800);
    expect(liveAt(tracker, 800)?.ttftMs).toBe(800);

    tracker.observe(stepStarted("s1", "m2", 5000, 5000), 4000);
    expect(liveAt(tracker, 4000)?.ttftMs).toBeNull();
    tracker.observe(delta("s1", "m2", 5600, "hello", 0), 4600);
    expect(liveAt(tracker, 4600)?.ttftMs).toBe(600);

    tracker.observe(streamed("s1", "m2", 6000), 5000);
    tracker.observe(stepEnded("s1", "m2", 6500), 5500);
    tracker.observe(executionEnded("s1", 7000), 6000);
    expect(liveAt(tracker, 6000)).toMatchObject({ phase: "idle", ttftMs: 600, active: false });

    const attached = new LiveTracker();
    attached.observe(delta("s1", "m1", 1000, "hello", 0), 0);
    expect(liveAt(attached, 0)).toMatchObject({ ttftMs: null, ttftSource: null, elapsedMs: null });
    attached.observe(executionEnded("s1", 1200), 200);
    expect(liveAt(attached, 200)?.ttftMs).toBeNull();
  });

  it("does not count empty deltas or invalid ordered start timestamps", () => {
    const tracker = new LiveTracker();
    tracker.observe(stepStarted("s1", "m1", 1000, 1000), 0);
    tracker.observe(delta("s1", "m1", 1200, "", 0), 200);
    expect(liveAt(tracker, 200)?.ttftMs).toBeNull();
    tracker.observe(delta("s1", "m1", 1800, "hello", 0), 800);
    expect(liveAt(tracker, 800)?.ttftMs).toBe(800);

    const invalid = new LiveTracker();
    invalid.observe(stepStarted("s1", "m1", 1000, 2000), 0);
    invalid.observe(delta("s1", "m1", 2500, "hello", 0), 1500);
    expect(liveAt(invalid, 1500)?.ttftMs).toBeNull();
  });

  it("tracks concurrent tools by id and retains tool state until matching terminals", () => {
    const tracker = new LiveTracker();
    tracker.observe(executionStarted("s1", 900), 0);
    tracker.observe(stepStarted("s1", "m1", 1000, 1000), 0);
    tracker.observe(delta("s1", "m1", 1500, "a", 0), 0);
    tracker.observe(delta("s1", "m1", 2500, "b".repeat(40), 1), 1000);
    expect(liveAt(tracker, 1000)?.estimatedTps).toBeCloseTo(10);

    tracker.observe(toolCalled("s1", "m1", 3000, "t1"), 2000);
    tracker.observe(toolCalled("s1", "m1", 3100, "t2"), 2100);
    expect(liveAt(tracker, 2100)).toMatchObject({ phase: "tool", activeTools: 2, estimatedTps: null });

    tracker.observe(toolSuccess("s1", "m1", 4000, "t1"), 3000);
    expect(liveAt(tracker, 3000)).toMatchObject({ phase: "tool", activeTools: 1, estimatedTps: null });
    tracker.observe(toolSuccess("s1", "m1", 4100, "t2"), 3100);
    expect(liveAt(tracker, 3100)).toMatchObject({ phase: "waiting", activeTools: 0, estimatedTps: null });

    tracker.observe(streamed("s1", "m1", 5000), 4000);
    tracker.observe(toolCalled("s1", "m1", 5200, "t3"), 4200);
    expect(liveAt(tracker, 4200)).toMatchObject({ phase: "tool", streamEnded: true, activeTools: 1 });
    tracker.observe(toolSuccess("s1", "m1", 5300, "t3"), 4300);
    expect(liveAt(tracker, 4300)).toMatchObject({ phase: "settling", streamEnded: true, activeTools: 0 });
  });

  it("keeps tool phase when the provider stream ends before matching tool terminals", () => {
    const tracker = new LiveTracker();
    tracker.observe(executionStarted("s1", 900), 0);
    tracker.observe(stepStarted("s1", "m1", 1000, 1000), 0);
    tracker.observe(delta("s1", "m1", 1500, "a", 0), 0);
    tracker.observe(toolCalled("s1", "m1", 1600, "t1"), 100);
    tracker.observe(streamed("s1", "m1", 2000), 500);
    expect(liveAt(tracker, 500)).toMatchObject({
      phase: "tool",
      streamEnded: true,
      activeTools: 1,
      estimatedTps: null,
    });
    tracker.observe(toolSuccess("s1", "m1", 2500, "t1"), 1000);
    expect(liveAt(tracker, 1000)).toMatchObject({
      phase: "settling",
      streamEnded: true,
      activeTools: 0,
      estimatedTps: null,
    });
  });

  it("moves stream end to settling immediately, then idle after completion", () => {
    const tracker = new LiveTracker();
    tracker.observe(executionStarted("s1", 900), 0);
    tracker.observe(stepStarted("s1", "m1", 1000, 1000), 0);
    tracker.observe(delta("s1", "m1", 1500, "a", 0), 0);
    tracker.observe(delta("s1", "m1", 2500, "b".repeat(40), 1), 1000);
    expect(liveAt(tracker, 1000)?.estimatedTps).toBeCloseTo(10);

    tracker.observe(streamed("s1", "m1", 3000), 2000);
    expect(liveAt(tracker, 2000)).toMatchObject({ phase: "settling", estimatedTps: null, active: true });
    tracker.observe(stepEnded("s1", "m1", 3500), 2500);
    expect(liveAt(tracker, 2500)).toMatchObject({ phase: "waiting", estimatedTps: null });
    tracker.observe(executionEnded("s1", 4000), 3000);
    expect(liveAt(tracker, 3000)).toMatchObject({ phase: "idle", estimatedTps: null, active: false });
  });

  it("clears windows on retry/failure and rejects stale or wrong-step output", () => {
    const tracker = new LiveTracker();
    tracker.observe(stepStarted("s1", "m1", 1000, 1000), 0);
    tracker.observe(delta("s1", "m1", 1500, "a", 0), 0);
    tracker.observe(delta("s1", "m1", 2500, "b".repeat(40), 1), 1000);
    expect(liveAt(tracker, 1000)).toMatchObject({ ttftMs: 500, elapsedMs: 1000 });
    tracker.observe(retry("s1", "m1", 3000), 2000);
    expect(liveAt(tracker, 2000)).toMatchObject({
      phase: "retry",
      estimatedTps: null,
      ttftMs: null,
      elapsedMs: null,
      stepStartedAt: null,
    });
    expect(tracker.observe(delta("s1", "m1", 3200, "c".repeat(40), 2), 2100).changed).toBe(false);

    const statusRetry = new LiveTracker();
    statusRetry.observe(stepStarted("s1", "m1", 1000, 1000), 0);
    statusRetry.observe(delta("s1", "m1", 1800, "a", 0), 800);
    expect(liveAt(statusRetry, 800)?.ttftMs).toBe(800);
    statusRetry.observe(statusEvent("s1", "retry", 2000), 1000);
    expect(liveAt(statusRetry, 1000)).toMatchObject({
      phase: "retry",
      ttftMs: null,
      elapsedMs: null,
      stepStartedAt: null,
    });

    tracker.observe(stepStarted("s1", "m2", 4000, 4000), 3000);
    tracker.observe(delta("s1", "m2", 4500, "d", 0), 3100);
    expect(tracker.observe(delta("s1", "m1", 5000, "e".repeat(40), 3), 3200).changed).toBe(false);
    tracker.observe(executionFailed("s1", 6000), 4000);
    expect(liveAt(tracker, 4000)).toMatchObject({ phase: "idle", estimatedTps: null, activeTools: 0 });
  });
});

describe("live isolation, bootstrap and validation", () => {
  it("keeps sessions independent and never borrows another scope's state", () => {
    const tracker = new LiveTracker();
    tracker.observe(delta("s1", "m1", 1000, "a", 0), 0);
    tracker.observe(delta("s1", "m1", 2000, "b".repeat(40), 1), 1000);
    tracker.observe(delta("s2", "m2", 1000, "a", 0), 0);
    expect(liveAt(tracker, 1000, "s1")?.estimatedTps).toBeCloseTo(10);
    expect(liveAt(tracker, 1000, "s2")?.estimatedTps).toBeNull();
    expect(tracker.snapshot(["s1"], 1000).map((entry) => entry.sessionID)).toEqual(["s1"]);
    expect(liveSnapshotFor(tracker.snapshot(["s1", "s2"], 1000), "s2")?.sessionID).toBe("s2");
  });

  it("bootstraps running sessions without inventing elapsed or TTFT, and removes stale bootstrap", () => {
    const tracker = new LiveTracker();
    expect(tracker.bootstrapRunning(["s1"])).toBe(true);
    expect(liveAt(tracker, 1000)).toMatchObject({
      phase: "waiting",
      elapsedMs: null,
      ttftMs: null,
      estimatedTps: null,
    });
    tracker.observe(delta("s1", "m1", 1000, "hello", 0), 0);
    expect(liveAt(tracker, 0)).toMatchObject({ ttftMs: null, elapsedMs: null, phase: "streaming" });
    // Explicit event state is authoritative: an empty running set does not
    // delete it, unlike a bootstrap-only waiting state.
    expect(tracker.bootstrapRunning([])).toBe(false);
    expect(liveAt(tracker, 0)).not.toBeNull();
    expect(tracker.bootstrapRunning(["s2"])).toBe(true);
    expect(liveAt(tracker, 0, "s2")?.phase).toBe("waiting");

    const staleBootstrap = new LiveTracker();
    expect(staleBootstrap.bootstrapRunning(["s1"])).toBe(true);
    expect(staleBootstrap.bootstrapRunning([])).toBe(true);
    expect(liveAt(staleBootstrap, 0)).toBeNull();
  });

  it("fails closed on malformed, unknown, duplicate and stale payloads", () => {
    const tracker = new LiveTracker();
    expect(tracker.observe({} as OpenCodeEvent, 0).changed).toBe(false);
    expect(
      tracker.observe(event("unknown", "session.unknown", 1000, { sessionID: "s1" }), 0).changed,
    ).toBe(false);
    expect(
      tracker.observe(event("missing", "session.text.delta", 1000, { delta: "x" }), 0).changed,
    ).toBe(false);
    expect(
      tracker.observe(event("nan", "session.text.delta", Number.NaN, { sessionID: "s1" }), 0).changed,
    ).toBe(false);

    tracker.observe(stepStarted("s1", "m1", 1000, 1000), 0);
    const wrongStep = delta("s1", "m2", 1500, "wrong", 0);
    expect(tracker.observe(wrongStep, 100).changed).toBe(false);
    expect(liveAt(tracker, 100)?.messageID).toBe("m1");

    const first = delta("s1", "m1", 1500, "a", 0);
    expect(tracker.observe(first, 0).changed).toBe(true);
    expect(tracker.observe(first, 0).changed).toBe(false);
    // Distinct event identities with the same message/source/ordinal/created
    // and equal character counts are legitimate chunks, not duplicates.
    const sameShapeA = event("distinct-a", "session.text.delta", 1500, {
      sessionID: "s1",
      assistantMessageID: "m1",
      ordinal: 0,
      delta: "ab",
    });
    const sameShapeB = event("distinct-b", "session.text.delta", 1500, {
      sessionID: "s1",
      assistantMessageID: "m1",
      ordinal: 0,
      delta: "cd",
    });
    expect(tracker.observe(sameShapeA, 0).changed).toBe(true);
    expect(tracker.observe(sameShapeB, 0).changed).toBe(true);
    // Exact replay of the same event identity is still rejected.
    expect(tracker.observe(sameShapeB, 0).changed).toBe(false);
    const stale = delta("s1", "m1", 1400, "b", 1);
    expect(tracker.observe(stale, 100).changed).toBe(false);

    tracker.observe(streamed("s1", "m1", 2000), 500);
    expect(tracker.observe(delta("s1", "m1", 2100, "late", 2), 600).changed).toBe(false);
    tracker.observe(stepEnded("s1", "m1", 2200), 700);
    expect(tracker.observe(delta("s1", "m1", 2300, "late", 3), 800).changed).toBe(false);
  });
});

describe("live presentation", () => {
  const liveStreaming: LiveScopeSnapshot = {
    sessionID: "s1",
    phase: "streaming",
    messageID: "m1",
    stepStartedAt: 1000,
    estimatedTps: 10,
    elapsedMs: 1500,
    ttftMs: 800,
    ttftSource: "observed",
    activeTools: 0,
    streamEnded: false,
    active: true,
  };

  it("shows a visible approximate estimate plus activity and observed TTFT", () => {
    const row = liveRowPresentation(liveStreaming, "en", true, "50.0 tokens/s");
    expect(row.estimate).toBe("~10.0 tokens/s");
    expect(row.approximate).toBe(true);
    expect(row.activity).toBe("Receiving output");
    expect(row.detail).toContain("Elapsed 1.5 s");
    expect(row.detail).toContain("Last final 50.0 tokens/s");
    expect(row.ttft).toBe("800 ms observed");
    expect(formatTtft(800, "en")).toBe("800 ms");
    expect(formatTtft(1500, "en")).toBe("1.5 s");
  });

  it("suppresses the numeric estimate when disabled while keeping TTFT/activity/final", () => {
    const row = liveRowPresentation(liveStreaming, "en", false, "50.0 tokens/s");
    expect(row.estimate).toBe("Live estimate off");
    expect(row.estimate).not.toContain("10.0");
    expect(row.activity).toBe("Receiving output");
    expect(row.ttft).toBe("800 ms observed");
    expect(row.detail).toContain("Last final 50.0 tokens/s");
  });

  it("uses tool state instead of a retained speed", () => {
    const row = liveRowPresentation(
      { ...liveStreaming, phase: "tool", estimatedTps: null, activeTools: 2 },
      "en",
      true,
      null,
    );
    expect(row.activity).toBe("2 tools running");
    expect(row.estimate).toBe("—");
    expect(row.approximate).toBe(false);
  });

  it("localizes row copy in Spanish", () => {
    const row = liveRowPresentation(liveStreaming, "es", true, null);
    expect(row.estimate).toContain("10,0 tokens/s");
    expect(row.activity).toBe("Recibiendo salida");
    expect(row.ttft).toBe("800 ms observado");
  });

  it("keeps the hybrid header approximate, completed-context and TTFT labels distinct", () => {
    const summary = summaryWithFinal(50);
    const live = headerBadgePresentation(
      { status: "ready", summary, error: null, reason: null },
      true,
      "en",
      liveStreaming,
      true,
    );
    expect(live.text).toBe("~10.0 tokens/s");
    expect(live.live).toBe(true);
    expect(live.label).toContain("Estimated live");
    expect(live.label).not.toContain("Last completed response");
    expect(live.ttft).toBe("TTFT 800 ms");

    const disabled = headerBadgePresentation(
      { status: "ready", summary, error: null, reason: null },
      true,
      "en",
      liveStreaming,
      false,
    );
    expect(disabled.text).toBe("50.0 tokens/s");
    expect(disabled.text).not.toContain("final");
    expect(disabled.text).not.toContain("~");
    expect(disabled.label).toContain("Last completed response 50.0 tokens/s");
    expect(disabled.label).toContain("Live estimate off");
    expect(disabled.ttft).toBe("TTFT 800 ms");

    const waiting = headerBadgePresentation(
      { status: "ready", summary, error: null, reason: null },
      true,
      "en",
      { ...liveStreaming, phase: "waiting", estimatedTps: null, ttftMs: null },
      true,
    );
    expect(waiting.text).toBe("50.0 tokens/s");
    expect(waiting.text).not.toContain("final");
    expect(waiting.label).toContain("Last completed response 50.0 tokens/s");
    expect(waiting.activity).toBe("waiting");

    const waitingEmpty = headerBadgePresentation(
      { status: "ready", summary: emptySummary, error: null, reason: null },
      true,
      "en",
      { ...liveStreaming, phase: "waiting", estimatedTps: null, ttftMs: null },
      true,
    );
    expect(waitingEmpty.text).toBe("TPS …");

    const idle = headerBadgePresentation(
      { status: "ready", summary, error: null, reason: null },
      true,
      "en",
      { ...liveStreaming, phase: "idle", estimatedTps: null, active: false },
      true,
    );
    expect(idle.text).toBe("50.0 tokens/s");
    expect(idle.text).not.toContain("final");
    expect(idle.ttft).toBe("TTFT 800 ms");
  });

  it("removes the visible final label while retaining completed provenance in both languages", () => {
    const cases = [
      {
        lang: "en" as const,
        rate: "50.0 tokens/s",
        completed: "Last completed response 50.0 tokens/s",
        waiting: "waiting",
        tools: "2 tools",
      },
      {
        lang: "es" as const,
        rate: "50,0 tokens/s",
        completed: "Última respuesta completada 50,0 tokens/s",
        waiting: "esperando",
        tools: "2 herramientas",
      },
    ];
    for (const c of cases) {
      const states = [
        { live: { ...liveStreaming, phase: "waiting" as const, estimatedTps: null }, activity: c.waiting },
        {
          live: { ...liveStreaming, phase: "tool" as const, estimatedTps: null, activeTools: 2 },
          activity: c.tools,
        },
      ];
      for (const state of states) {
        const header = headerBadgePresentation(
          { status: "ready", summary: summaryWithFinal(50), error: null, reason: null },
          true,
          c.lang,
          state.live,
          true,
        );
        expect(header.text).toBe(c.rate);
        expect(header.text).not.toMatch(/final/i);
        expect(header.label).toContain(c.completed);
        expect(header.label).toContain(state.activity);
        expect(header.label).toContain("TTFT 800 ms");
        expect(header.live).toBe(false);
      }
    }
  });

  it("preserves the final-only header policy when no live state is supplied", () => {
    const ready = headerBadgePresentation(
      { status: "ready", summary: summaryWithFinal(50), error: null, reason: null },
      true,
      "en",
    );
    expect(ready.text).toBe("50.0 tokens/s");
    expect(ready.label).toMatch(/session/);
    expect(ready.live).toBeUndefined();
  });
});

describe("live preference compatibility", () => {
  it("decodes old language-only stores through the real schema and keeps language", () => {
    const script = [
      'import { Schema } from "effect";',
      'import { PrefsSchema } from "./src/prefs.ts";',
      'const old = Schema.decodeUnknownSync(PrefsSchema)({ language: "es" });',
      'const off = Schema.decodeUnknownSync(PrefsSchema)({ language: "en", liveEstimate: false });',
      'const on = Schema.decodeUnknownSync(PrefsSchema)({ language: "es", liveEstimate: true });',
      'console.log(JSON.stringify({ old, off, on }));',
    ].join("\n");
    const output = execFileSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      old: { language: "es", liveEstimate: true, viewMode: "simple" },
      off: { language: "en", liveEstimate: false, viewMode: "simple" },
      on: { language: "es", liveEstimate: true, viewMode: "simple" },
    });
  });

  it("defaults on for old language-only preferences and honors explicit false", () => {
    expect(normalizeLiveEstimate(undefined)).toBe(true);
    expect(normalizeLiveEstimate(null)).toBe(true);
    expect(normalizeLiveEstimate(false)).toBe(false);
    expect(normalizeLiveEstimate(true)).toBe(true);
    expect(liveEstimateFromStoreValue(undefined)).toBe(true);
    expect(liveEstimateFromStoreValue({ language: "es" })).toBe(true);
    expect(liveEstimateFromStoreValue({ language: "en", liveEstimate: false })).toBe(false);
    expect(liveEstimateFromStoreValue({ language: "es", liveEstimate: true })).toBe(true);
  });
});

describe("live disclosure and session-scoped final context", () => {
  it("explains language/content bias, buffering and live vs final denominators", () => {
    expect(t("en", "about.live")).toMatch(/language and content/i);
    expect(t("en", "about.live")).toMatch(/buffered transport/i);
    expect(t("en", "about.live")).toMatch(/streamed − created/i);
    expect(t("es", "about.live")).toMatch(/idioma y el contenido/i);
    expect(t("es", "about.live")).toMatch(/búfer/i);
    expect(t("es", "about.live")).toMatch(/streamed − created/i);
  });

  it("uses the same session summary for final context, not the historical agent filter", () => {
    expect(sessionFinalRate(summaryWithFinal(50), "en")).toBe("50.0 tokens/s");
    expect(sessionFinalRate(emptySummary, "en")).toBeNull();
    const view = readFileSync(new URL("../src/view.tsx", import.meta.url), "utf8");
    expect(view).toContain("sessionFinalRate(snap().summary");
    expect(view).toContain("live.sessionScope");
    expect(view).toContain("scopeLabel={resolved().label}");
    expect(view).not.toContain("sessionFinalRate(scopedSummary");
  });
});

// ---------------------------------------------------------------------------
// Shared-tree integration: one throttled scheduler, no fetch on ticks/leaks.
// ---------------------------------------------------------------------------

function session(id: string, parentID?: string): SessionInfo {
  return {
    id,
    projectID: "proj",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/tmp" },
    ...(parentID !== undefined ? { parentID } : {}),
  } as SessionInfo;
}

function msgPage(): SessionMessagesResponse {
  return { data: [], cursor: { previous: null, next: null } };
}

function sessionPage(data: SessionInfo[]): SessionsResponse {
  return { data, cursor: { previous: null, next: null } };
}

interface TreeHarness {
  controller: SessionTreeController;
  fire: (details: OpenCodeEvent) => void;
  callsBySession: Map<string, number>;
  unsubscribed: () => number;
  notifies: ((details: OpenCodeEvent) => void)[];
  renew: (connected?: boolean) => {
    previous: ((details: OpenCodeEvent) => void) | null;
    current: ((details: OpenCodeEvent) => void) | null;
  };
}

function treeHarness(
  serverID: string,
  rootID: string,
  opts: { children?: Map<string, SessionInfo[]>; now: () => number },
): TreeHarness {
  const callsBySession = new Map<string, number>();
  const notifies: ((details: OpenCodeEvent) => void)[] = [];
  let treeNotify: ((details: OpenCodeEvent) => void) | null = null;
  let unsubs = 0;
  const refs = { client: {}, data: {} };
  const fetchPage: FetchPage = async (input) => {
    callsBySession.set(input.sessionID, (callsBySession.get(input.sessionID) ?? 0) + 1);
    return msgPage();
  };
  const listPage = async ({ parentID }: { parentID: string }) =>
    sessionPage(opts.children?.get(parentID) ?? []);
  const seamFor = (connected: boolean, connectionRefs: { client: unknown; data: unknown }): TransportSeam => ({
    fetchPage,
    subscribe: () => () => {},
    isConnected: () => connected,
    refs: connectionRefs,
  });
  const subscribeTree = (notify: (details: OpenCodeEvent) => void) => {
    treeNotify = notify;
    notifies.push(notify);
    return () => {
      if (treeNotify === notify) treeNotify = null;
      unsubs += 1;
    };
  };
  const controller = new SessionTreeController({
    serverID,
    rootSessionID: rootID,
    listPage,
    seamForSession: () => seamFor(true, refs),
    subscribeTree,
    isConnected: () => true,
    refs,
    debounceMs: 0,
    now: opts.now,
  });
  return {
    controller,
    fire: (details) => treeNotify?.(details),
    callsBySession,
    unsubscribed: () => unsubs,
    notifies,
    renew: (connected = true) => {
      const previous = treeNotify;
      const nextRefs = { client: { v: 2 }, data: { v: 2 } };
      controller.replaceConnection({
        listPage,
        seamForSession: () => seamFor(connected, nextRefs),
        subscribeTree,
        isConnected: () => connected,
        refs: nextRefs,
      });
      return { previous, current: treeNotify };
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("shared tree live scheduling", () => {
  it("publishes at most ~4 Hz for deltas, never fetches on ticks, and cleans up", async () => {
    let now = 0;
    const h = treeHarness("live-tree", "root", { now: () => now });
    await h.controller.load();
    const callsAfterLoad = h.callsBySession.get("root") ?? 0;
    const updates: TreeSnapshot[] = [];
    const unwatch = h.controller.onUpdate((snap) => updates.push(snap));

    h.fire(stepStarted("root", "m1", 1000, 1000));
    h.fire(delta("root", "m1", 1500, "a", 0));
    for (let i = 1; i <= 20; i += 1) {
      now = i * 50;
      h.fire(delta("root", "m1", 1500 + i * 50, "x".repeat(4), i));
    }
    const live = h.controller.getState().live?.find((entry) => entry.sessionID === "root");
    expect(live?.estimatedTps).toBeGreaterThan(0);
    // Immediate step transition plus at most four delta publications in 1 s.
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.length).toBeLessThanOrEqual(6);
    expect(h.callsBySession.get("root") ?? 0).toBe(callsAfterLoad);

    await wait(320);
    expect(h.callsBySession.get("root") ?? 0).toBe(callsAfterLoad);

    h.fire(executionEnded("root", 5000));
    const stopped = updates.length;
    await wait(320);
    expect(updates.length).toBe(stopped);

    unwatch();
    h.controller.dispose();
    expect(h.unsubscribed()).toBe(1);
  });

  it("coordinates timer and delta publication on the real scheduled timeline", async () => {
    const h = treeHarness("live-tree-fake", "root", { now: () => Date.now() });
    await h.controller.load();
    const callsAfterLoad = h.callsBySession.get("root") ?? 0;
    const updates: TreeSnapshot[] = [];
    const unwatch = h.controller.onUpdate((snap) => updates.push(snap));
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      h.fire(stepStarted("root", "m1", 1000, 1000));
      h.fire(delta("root", "m1", 1500, "a", 0));
      for (let i = 1; i <= 20; i += 1) {
        vi.advanceTimersByTime(50);
        h.fire(delta("root", "m1", 1500 + i * 50, "x".repeat(4), i));
      }
      // One immediate lifecycle publication plus at most four timer/delta
      // publications in one second. The timer and deltas share one throttle.
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.length).toBeLessThanOrEqual(5);
      expect(h.callsBySession.get("root") ?? 0).toBe(callsAfterLoad);

      h.fire(executionEnded("root", 5000));
      expect(vi.getTimerCount()).toBe(0);
      const stopped = updates.length;
      vi.advanceTimersByTime(1000);
      expect(updates.length).toBe(stopped);
    } finally {
      unwatch();
      h.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("gates unrelated sessions and running IDs away from followed live state", async () => {
    const h = treeHarness("live-tree-gated", "root", { now: () => Date.now() });
    await h.controller.load();
    const updates: TreeSnapshot[] = [];
    const unwatch = h.controller.onUpdate((snap) => updates.push(snap));
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      h.fire(stepStarted("root", "m1", 1000, 1000));
      h.fire(delta("root", "m1", 1500, "a", 0));
      vi.advanceTimersByTime(500);
      h.fire(delta("root", "m1", 2500, "b".repeat(40), 1));
      const before = h.controller.getState().live?.find((entry) => entry.sessionID === "root");
      expect(before?.estimatedTps).toBeGreaterThan(0);
      expect(before?.ttftMs).toBe(500);
      const beforeUpdates = updates.length;
      const unrelated: string[] = [];
      for (let i = 0; i < LIVE_MAX_SESSIONS + 50; i += 1) {
        const id = `unrelated-${i}`;
        unrelated.push(id);
        h.fire(statusEvent(id, "busy", 1000 + i));
        h.fire(delta(id, `m-${i}`, 1500 + i, "z", 0));
      }
      h.controller.reconcileRunning(unrelated);
      const after = h.controller.getState().live?.find((entry) => entry.sessionID === "root");
      expect(after?.estimatedTps).toBeGreaterThan(0);
      expect(after?.ttftMs).toBe(500);
      expect(h.controller.getState().live).toHaveLength(1);
      expect(updates.length).toBe(beforeUpdates);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      unwatch();
      h.controller.dispose();
      vi.useRealTimers();
    }
  });

  it("stops live timers on disconnect, renewal and disposal; stale callbacks stay dead", async () => {
    const disconnect = treeHarness("live-tree-disc", "root", { now: () => Date.now() });
    await disconnect.controller.load();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      disconnect.fire(stepStarted("root", "m1", 1000, 1000));
      disconnect.fire(delta("root", "m1", 1500, "a", 0));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      disconnect.controller.markDisconnected();
      expect(vi.getTimerCount()).toBe(0);
      expect(disconnect.controller.getState().live).toEqual([]);
    } finally {
      disconnect.controller.dispose();
      vi.useRealTimers();
    }

    const renewal = treeHarness("live-tree-renew", "root", { now: () => Date.now() });
    await renewal.controller.load();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      renewal.fire(stepStarted("root", "m1", 1000, 1000));
      renewal.fire(delta("root", "m1", 1500, "a", 0));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const oldNotify = renewal.notifies[renewal.notifies.length - 1]!;
      renewal.renew(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(renewal.controller.getState().live).toEqual([]);
      oldNotify(statusEvent("root", "busy", 2000));
      oldNotify(delta("root", "m1", 2500, "late", 1));
      expect(renewal.controller.getState().live).toEqual([]);
    } finally {
      renewal.controller.dispose();
      vi.useRealTimers();
    }

    const stale = treeHarness("live-tree-stale", "root", { now: () => Date.now() });
    await stale.controller.load();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      stale.fire(stepStarted("root", "m1", 1000, 1000));
      stale.fire(delta("root", "m1", 1500, "a", 0));
      const oldNotify = stale.notifies[stale.notifies.length - 1]!;
      stale.renew(true);
      expect(stale.controller.getState().live).toEqual([]);
      oldNotify(statusEvent("root", "busy", 2000));
      oldNotify(delta("root", "m1", 2500, "late", 1));
      expect(stale.controller.getState().live).toEqual([]);
    } finally {
      stale.controller.dispose();
      vi.useRealTimers();
    }

    const disposal = treeHarness("live-tree-dispose", "root", { now: () => Date.now() });
    await disposal.controller.load();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      disposal.fire(stepStarted("root", "m1", 1000, 1000));
      disposal.fire(delta("root", "m1", 1500, "a", 0));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      disposal.controller.dispose();
      expect(vi.getTimerCount()).toBe(0);
      expect(disposal.controller.getState().live).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });


  it("follows the selected delegate's own live state without borrowing the root", async () => {
    let now = 0;
    const h = treeHarness("live-tree-2", "root", {
      now: () => now,
      children: new Map([["root", [session("c1", "root"), session("c2", "root")]]]),
    });
    await h.controller.load();
    h.fire(statusEvent("c1", "busy", 100));
    h.fire(stepStarted("c1", "m1", 800, 800));
    h.fire(delta("c1", "m1", 900, "a", 0));
    now = 500;
    h.fire(delta("c1", "m1", 1400, "b".repeat(40), 1));

    h.fire(statusEvent("c2", "busy", 200));
    h.fire(stepStarted("c2", "m2", 1000, 1000));
    h.fire(delta("c2", "m2", 1100, "a", 0));
    now = 1500;
    h.fire(delta("c2", "m2", 1600, "c".repeat(40), 1));
    expect(h.controller.getActiveDelegateID()).toBe("c2");

    const tree = h.controller.getState();
    const selection = headerScopeForTree(tree, tree.activeDelegateID);
    expect(selection.sessionID).toBe("c2");
    const liveC2 = liveSnapshotFor(tree.live, "c2");
    expect(liveC2?.estimatedTps).toBeGreaterThan(0);
    const header = headerBadgePresentation(selection.snap, true, "en", liveC2, true);
    expect(header.text).toContain("~");
    expect(header.live).toBe(true);

    // A newer verified busy event switches the header back to c1; its live
    // state is independent and the panel selection is not involved here.
    h.fire(statusEvent("c1", "busy", 3000));
    expect(h.controller.getActiveDelegateID()).toBe("c1");
    const switched = h.controller.getState();
    const liveC1 = liveSnapshotFor(switched.live, "c1");
    expect(liveC1?.estimatedTps).toBeGreaterThan(0);
    expect(liveSnapshotFor(switched.live, "root")).toBeNull();

    h.controller.dispose();
  });
});
