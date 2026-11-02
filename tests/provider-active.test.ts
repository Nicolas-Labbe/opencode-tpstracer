import { describe, expect, it } from "vitest";
import {
  collectObservations,
  collectSamples,
  summarize,
  toObservation,
  toSample,
} from "../src/metrics.js";
import { hasScopeContent, latestMeasurement, scopeRenderPolicy, trendPoints } from "../src/presentation.js";
import type { TpsSample } from "../src/metrics.js";
import { SessionMetricsController } from "../src/adapter.js";
import type { FetchPage, TransportSeam } from "../src/transport.js";
import type { SessionMessagesResponse } from "@opencode/client/promise";

function msg(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    agent: "build",
    model: { providerID: "acme", id: "fast" },
    tokens: { input: 10, output: 500, reasoning: 100, cache: { read: 0, write: 0 } },
    time: { created: 0, streamed: 10_000, completed: 100_000 },
    finish: "stop",
    ...overrides,
  };
}

function wallMsg(id: string, output: number, reasoning: unknown, created: number, streamed: unknown, completed: number) {
  return {
    id,
    agent: "build",
    model: { providerID: "acme", id: "fast" },
    tokens: { input: 1, output, ...(reasoning === undefined ? {} : { reasoning }), cache: { read: 0, write: 0 } },
    time: { created, ...(streamed === undefined ? {} : { streamed }), completed },
    finish: "stop",
  };
}

describe("provider-active primary and wall secondary", () => {
  it("pairs 500 output + 100 reasoning over 10 active s as 60 primary and 5 wall", () => {
    const s = toSample(msg());
    expect(s?.primaryTps).toBe(60);
    expect(s?.wallTps).toBe(5);
    expect(s?.tps).toBe(5);
    expect(s?.generated).toBe(600);
    expect(s?.activeDurationMs).toBe(10_000);
    expect(s?.durationMs).toBe(100_000);
    expect(s?.streamed).toBe(10_000);
  });

  it("increasing only completed does not reduce primary", () => {
    const before = toSample(msg({ time: { created: 0, streamed: 10_000, completed: 100_000 } }));
    const after = toSample(msg({ time: { created: 0, streamed: 10_000, completed: 200_000 } }));
    expect(before?.primaryTps).toBe(60);
    expect(after?.primaryTps).toBe(60);
    expect(after?.wallTps).toBe(2.5);
  });

  it("weights paired active durations as 20, not the mean 31.25", () => {
    const samples = collectSamples([
      wallMsg("a", 80, 20, 0, 2_000, 5_000),
      wallMsg("b", 90, 10, 0, 8_000, 10_000),
    ]);
    expect(samples).toHaveLength(2);
    const summary = summarize(samples);
    // (100 + 100) / 10 active s => 20; mean of 50 and 12.5 would be 31.25.
    expect(summary.weightedPrimaryTps).toBe(20);
    expect(summary.weightedPrimaryTps).not.toBe(31.25);
    expect(summary.activeCount).toBe(2);
    expect(summary.totalGenerated).toBe(200);
    expect(summary.totalActiveDurationMs).toBe(10_000);
  });

  it("leaves primary unavailable but preserves wall when streamed or reasoning is missing", () => {
    const noStreamed = toSample(wallMsg("a", 100, 20, 0, undefined, 2_000));
    expect(noStreamed).not.toBeNull();
    expect(noStreamed?.primaryTps).toBeNull();
    expect(noStreamed?.wallTps).toBe(50);

    const noReasoning = toSample({
      id: "b",
      agent: "build",
      model: { providerID: "acme", id: "fast" },
      tokens: { output: 100 },
      time: { created: 0, streamed: 1_000, completed: 2_000 },
      finish: "stop",
    });
    expect(noReasoning).not.toBeNull();
    expect(noReasoning?.reasoning).toBeNull();
    expect(noReasoning?.primaryTps).toBeNull();
    expect(noReasoning?.wallTps).toBe(50);
  });

  it("leaves primary unavailable for invalid ordering without touching wall", () => {
    // streamed == created
    expect(toSample(wallMsg("a", 100, 10, 0, 0, 2_000))?.primaryTps).toBeNull();
    // streamed > completed
    expect(toSample(wallMsg("b", 100, 10, 0, 5_000, 2_000))?.primaryTps).toBeNull();
    // streamed before created
    expect(toSample(wallMsg("c", 100, 10, 5_000, 1_000, 9_000))?.primaryTps).toBeNull();
    // wall stays valid in each case
    expect(toSample(wallMsg("a", 100, 10, 0, 0, 2_000))?.wallTps).toBe(50);
  });

  it("excludes negative and nonfinite counts and failed steps from wall too", () => {
    expect(toSample(wallMsg("a", -1, 0, 0, 1_000, 2_000))).toBeNull();
    expect(toSample(wallMsg("b", 100, -2, 0, 1_000, 2_000))).toBeNull();
    expect(toSample(wallMsg("c", NaN, 0, 0, 1_000, 2_000))).toBeNull();
    expect(toSample(wallMsg("d", 100, Infinity, 0, 1_000, 2_000))).toBeNull();
    expect(toSample(msg({ error: { message: "boom" } }))).toBeNull();
    expect(toSample(msg({ error: undefined, finish: "error" }))).toBeNull();
    expect(toSample(msg({ time: { created: 0, streamed: 1_000 } }))).toBeNull();
  });

  it("accepts explicit zero counts as valid zero rates", () => {
    const s = toSample(wallMsg("z", 0, 0, 0, 1_000, 2_000));
    expect(s?.primaryTps).toBe(0);
    expect(s?.wallTps).toBe(0);
  });

  it("uses the latest completed observation even when usage is missing (no older borrowing)", () => {
    const measured = wallMsg("older", 80, 20, 0, 2_000, 5_000);
    const missingUsage = {
      id: "newer",
      agent: "build",
      model: { providerID: "acme", id: "fast" },
      time: { created: 6_000, completed: 8_000 },
      finish: "stop",
    };
    const samples = collectSamples([measured, missingUsage]);
    expect(samples.map((s) => s.id)).toEqual(["older"]);
    const observations = collectObservations([measured, missingUsage]);
    const summary = summarize(samples, observations);
    expect(summary.last?.id).toBe("older");
    expect(summary.lastCompleted?.id).toBe("newer");
    // Latest completed is unmeasured: UI must show unavailable, not the older 50.
    expect(summary.lastCompleted?.output).toBeNull();
    expect(summary.completedCount).toBe(2);
    expect(summary.count).toBe(1);
    expect(summary.activeCount).toBe(1);
    expect(summary.weightedPrimaryTps).toBe(50);
  });

  it("counts coverage over completed observations with missing usage", () => {
    const measured = wallMsg("m1", 80, 20, 0, 2_000, 5_000);
    const missing = {
      id: "m2",
      agent: "build",
      model: { providerID: "acme", id: "fast" },
      time: { created: 6_000, completed: 8_000 },
      finish: "stop",
    };
    const summary = summarize(collectSamples([measured, missing]), collectObservations([measured, missing]));
    expect(summary.completedCount).toBe(2);
    expect(summary.activeCount).toBe(1);
    expect(summary.failedCount).toBe(0);
    expect(summary.unfinishedCount).toBe(0);
  });

  it("keeps failed and unfinished apart without false rates", () => {
    const measured = wallMsg("ok", 80, 20, 0, 2_000, 5_000);
    const failed = msg({ id: "bad", error: { message: "boom" } });
    const unfinished = { id: "pending", agent: "build", model: { providerID: "acme", id: "fast" }, finish: "stop" };
    const samples = collectSamples([measured, failed, unfinished]);
    expect(samples.map((s) => s.id)).toEqual(["ok"]);
    const summary = summarize(samples, collectObservations([measured, failed, unfinished]));
    expect(summary.completedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.unfinishedCount).toBe(1);
    expect(summary.weightedPrimaryTps).toBe(50);
    expect(summary.weightedTps).toBe(16);
    expect(summary.lastCompleted?.id).toBe("ok");
  });

  it("keeps a child latest missing-usage on modelB without borrowing older modelA rates", () => {
    const olderMeasured = {
      ...wallMsg("older", 80, 20, 0, 2_000, 5_000),
      model: { providerID: "acme", id: "A" },
    };
    const latestMissing = {
      id: "newer",
      agent: "build",
      model: { providerID: "acme", id: "B" },
      time: { created: 6_000, completed: 8_000 },
      finish: "stop",
    };
    const samples = collectSamples([olderMeasured, latestMissing]);
    expect(samples.map((s) => s.id)).toEqual(["older"]);
    expect(samples[0]?.model).toBe("acme/A");
    const summary = summarize(samples, collectObservations([olderMeasured, latestMissing]));
    const latest = latestMeasurement(summary);
    // Latest primary/wall unavailable, modelB — never the older modelA rate.
    expect(latest).toEqual({ hasLatest: true, unmeasured: true, primary: null, wall: null, model: "acme/B" });
    // Finished-response count is 2 (no false 0); average pools the measured modelA pair.
    expect(summary.completedCount).toBe(2);
    expect(summary.count).toBe(1);
    expect(summary.weightedPrimaryTps).toBe(50);
    expect(summary.weightedTps).toBe(16);
  });

  it("reports mixed active coverage without mixing tokens or durations", () => {
    const samples = collectSamples([
      wallMsg("measured", 80, 20, 0, 2_000, 5_000),
      wallMsg("wall-only", 100, undefined, 0, undefined, 4_000),
    ]);
    const summary = summarize(samples);
    expect(summary.count).toBe(2);
    expect(summary.activeCount).toBe(1);
    expect(summary.totalGenerated).toBe(100);
    expect(summary.totalActiveDurationMs).toBe(2_000);
    expect(summary.weightedPrimaryTps).toBe(50);
    // Wall pairs both: 180 output / 9 wall s => 20.
    expect(summary.weightedTps).toBe(20);
    expect(summary.totalOutput).toBe(180);
  });
});

describe("completed without samples keeps honest unavailable content", () => {
  function missingUsageMsg(id: string, completed: number) {
    return {
      id,
      type: "assistant",
      agent: "build",
      model: { providerID: "acme", id: "fast" },
      content: [],
      time: { created: completed - 2000, completed },
      finish: "stop",
    };
  }

  function testSeam(fetchPage: FetchPage): TransportSeam {
    return { fetchPage, subscribe: () => () => {}, isConnected: () => true, refs: { client: {}, data: {} } };
  }

  it("reports ready with 0of2 coverage and unknown totals, never a false empty", async () => {
    const fetchPage: FetchPage = async () =>
      ({ data: [missingUsageMsg("a", 2000), missingUsageMsg("b", 4000)], cursor: { previous: null, next: null } }) as unknown as SessionMessagesResponse;
    const c = new SessionMetricsController({ serverID: "s", sessionID: "s1", transport: testSeam(fetchPage), debounceMs: 0 });
    await c.load();
    const snap = c.getState();
    expect(snap.status).toBe("ready");
    expect(snap.samples).toHaveLength(0);
    expect(snap.summary.count).toBe(0);
    expect(snap.summary.completedCount).toBe(2);
    expect(snap.summary.activeCount).toBe(0);
    expect(snap.summary.weightedPrimaryTps).toBeNull();
    expect(snap.summary.weightedTps).toBeNull();
    // Totals must render unknown when no wall/active pairs exist (never invented 0).
    expect(snap.summary.count).toBe(0);
    expect(hasScopeContent(snap)).toBe(true);
    const policy = scopeRenderPolicy("ready", snap);
    expect(policy.showContent).toBe(true);
    expect(policy.showLoading).toBe(false);
    c.dispose();
  });

  it("keeps genuine empty (no completed) as empty without content", async () => {
    const fetchPage: FetchPage = async () =>
      ({ data: [], cursor: { previous: null, next: null } }) as unknown as SessionMessagesResponse;
    const c = new SessionMetricsController({ serverID: "s", sessionID: "s1", transport: testSeam(fetchPage), debounceMs: 0 });
    await c.load();
    const snap = c.getState();
    expect(snap.status).toBe("empty");
    expect(snap.summary.completedCount).toBe(0);
    expect(hasScopeContent(snap)).toBe(false);
    expect(scopeRenderPolicy("ready", snap).showContent).toBe(false);
    c.dispose();
  });

  it("keeps content mounted during refresh with retained completed observations", () => {
    const snap = {
      status: "loading" as const,
      samples: [],
      summary: { completedCount: 2 } as never,
    };
    expect(hasScopeContent(snap)).toBe(true);
    expect(scopeRenderPolicy("ready", snap).showContent).toBe(true);
    expect(scopeRenderPolicy("ready", snap).showLoading).toBe(false);
  });
});

describe("observations preserve unmeasured rows without inventing zeros", () => {
  it("retains failed and missing-usage rows with known model metadata", () => {
    const failed = toObservation(msg({ error: { message: "boom" } }));
    expect(failed?.failed).toBe(true);
    expect(failed?.model).toBe("acme/fast");
    expect(failed?.output).toBe(500);

    const missing = toObservation({ id: "x", agent: "plan", model: { providerID: "acme", id: "slow" } });
    expect(missing?.output).toBeNull();
    expect(missing?.reasoning).toBeNull();
    expect(missing?.model).toBe("acme/slow");
    expect(missing?.failed).toBe(false);
  });

  it("collects observations for every id, even when samples exclude them", () => {
    const obs = collectObservations([
      msg({ id: "ok" }),
      msg({ id: "bad", error: { message: "boom" } }),
      { id: "nousage", model: { providerID: "acme", id: "fast" } },
    ]);
    expect(obs.map((o) => o.id)).toEqual(["ok", "bad", "nousage"]);
    const samples = collectSamples([
      msg({ id: "ok" }),
      msg({ id: "bad", error: { message: "boom" } }),
    ]);
    expect(samples.map((s) => s.id)).toEqual(["ok"]);
  });
});

describe("completed-timestamp tie keeps latest deterministic", () => {
  function tiePair() {
    const a = {
      ...wallMsg("a", 80, 20, 0, 2_000, 10_000),
      model: { providerID: "acme", id: "A" },
    };
    const z = {
      ...wallMsg("z", 120, 60, 0, 1_000, 10_000),
      model: { providerID: "acme", id: "Z" },
    };
    return { a, z };
  }

  function summarizeBoth(ordered: readonly unknown[]) {
    const msgs = ordered as Parameters<typeof collectSamples>[0];
    return summarize(collectSamples(msgs), collectObservations(msgs));
  }

  it("picks id-max z for last/lastCompleted/latest in both input orders", () => {
    const { a, z } = tiePair();
    for (const ordered of [[z, a], [a, z]]) {
      const summary = summarizeBoth(ordered);
      expect(summary.last?.id).toBe("z");
      expect(summary.lastCompleted?.id).toBe("z");
      expect(latestMeasurement(summary)).toEqual({
        hasLatest: true,
        unmeasured: false,
        primary: 180,
        wall: 12,
        model: "acme/Z",
      });
    }
  });

  it("keeps aggregates identical across tie permutations", () => {
    const { a, z } = tiePair();
    const first = summarizeBoth([z, a]);
    const second = summarizeBoth([a, z]);
    expect(second.totalOutput).toBe(first.totalOutput);
    expect(second.totalReasoning).toBe(first.totalReasoning);
    expect(second.totalDurationMs).toBe(first.totalDurationMs);
    expect(second.totalGenerated).toBe(first.totalGenerated);
    expect(second.totalActiveDurationMs).toBe(first.totalActiveDurationMs);
    expect(second.weightedPrimaryTps).toBe(first.weightedPrimaryTps);
    expect(second.weightedTps).toBe(first.weightedTps);
    expect(second.count).toBe(2);
    expect(second.activeCount).toBe(2);
    expect(second.completedCount).toBe(2);
  });

  it("keeps recency over id when completed differs", () => {
    const { a, z } = tiePair();
    const olderZ = { ...z, time: { created: 0, streamed: 1_000, completed: 10_000 } };
    const newerA = { ...a, time: { created: 0, streamed: 2_000, completed: 20_000 } };
    for (const ordered of [[olderZ, newerA], [newerA, olderZ]]) {
      const summary = summarizeBoth(ordered);
      expect(summary.last?.id).toBe("a");
      expect(summary.lastCompleted?.id).toBe("a");
      expect(latestMeasurement(summary)).toEqual({
        hasLatest: true,
        unmeasured: false,
        primary: 50,
        wall: 4,
        model: "acme/A",
      });
    }
  });

  it("keeps unmeasured id-max z unavailable without borrowing a", () => {
    const { a } = tiePair();
    const missingZ = {
      id: "z",
      agent: "build",
      model: { providerID: "acme", id: "Z" },
      time: { created: 0, completed: 10_000 },
      finish: "stop",
    };
    for (const ordered of [[missingZ, a], [a, missingZ]]) {
      const summary = summarizeBoth(ordered);
      expect(summary.last?.id).toBe("a");
      expect(summary.lastCompleted?.id).toBe("z");
      expect(latestMeasurement(summary)).toEqual({
        hasLatest: true,
        unmeasured: true,
        primary: null,
        wall: null,
        model: "acme/Z",
      });
    }
  });
});

describe("trend gaps stay honest", () => {
  function primarySample(id: string, completed: number, primary: number | null): TpsSample {
    return {
      id,
      agent: "build",
      model: "acme/fast",
      output: 100,
      reasoning: 0,
      created: completed - 2000,
      streamed: primary === null ? null : completed - 1000,
      completed,
      durationMs: 2000,
      activeDurationMs: primary === null ? null : 1000,
      generated: primary === null ? null : 100,
      tps: 50,
      wallTps: 50,
      primaryTps: primary,
    };
  }

  it("marks unmeasured responses as gaps without bridging or zero-plotting", () => {
    const pts = trendPoints([
      primarySample("a", 1000, 10),
      primarySample("b", 2000, null),
      primarySample("c", 3000, 20),
    ]);
    expect(pts.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(pts[1]?.gap).toBe(true);
    expect(pts[1]?.tps).toBeNull();
    expect(pts[1]?.ratio).toBe(0);
    expect(pts[0]?.gap).toBe(false);
    expect(pts[2]?.gap).toBe(false);
    // Peak from measured only (20): a => 0.5, c => 1.
    expect(pts[0]?.ratio).toBe(0.5);
    expect(pts[2]?.ratio).toBe(1);
  });
});
