import { describe, expect, it } from "vitest";
import { collectSamples, formatTokens, formatTps, summarize, toSample } from "../src/metrics.js";

function msg(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    model: { providerID: "acme", id: "fast" },
    tokens: { input: 10, output: 100, reasoning: 20, cache: { read: 0, write: 0 } },
    time: { created: 1_700_000_000_000, completed: 1_700_000_002_000 },
    finish: "stop",
    ...overrides,
  };
}

describe("toSample", () => {
  it("computes 50 t/s for 100 output tokens in 2s", () => {
    const s = toSample(msg());
    expect(s?.tps).toBe(50);
    expect(s?.durationMs).toBe(2000);
    expect(s?.model).toBe("acme/fast");
  });

  it("keeps reasoning separate from output", () => {
    const s = toSample(msg());
    expect(s?.output).toBe(100);
    expect(s?.reasoning).toBe(20);
    expect(s?.tps).toBe(50);
  });

  it("marks missing reasoning as unknown, not zero", () => {
    const s = toSample(msg({ tokens: { output: 100 } }));
    expect(s).not.toBeNull();
    expect(s?.reasoning).toBeNull();
    expect(s?.tps).toBe(50);
  });

  it("accepts real zero output with positive duration", () => {
    const s = toSample(msg({ tokens: { output: 0, reasoning: 0 } }));
    expect(s?.tps).toBe(0);
  });

  it("excludes missing usage", () => {
    expect(toSample(msg({ tokens: undefined }))).toBeNull();
    expect(toSample(msg({ tokens: null }))).toBeNull();
  });

  it("excludes NaN, negative and infinite counts", () => {
    expect(toSample(msg({ tokens: { output: NaN, reasoning: 0 } }))).toBeNull();
    expect(toSample(msg({ tokens: { output: -1, reasoning: 0 } }))).toBeNull();
    expect(toSample(msg({ tokens: { output: Infinity, reasoning: 0 } }))).toBeNull();
    expect(toSample(msg({ tokens: { output: 10, reasoning: -2 } }))).toBeNull();
    expect(toSample(msg({ tokens: { output: 10, reasoning: NaN } }))).toBeNull();
  });

  it("excludes invalid timestamps and zero duration", () => {
    expect(toSample(msg({ time: { created: 5, completed: 5 } }))).toBeNull();
    expect(toSample(msg({ time: { created: 10, completed: 5 } }))).toBeNull();
    expect(toSample(msg({ time: { created: NaN, completed: 8 } }))).toBeNull();
    expect(toSample(msg({ time: { created: 5 } }))).toBeNull();
  });

  it("excludes error responses", () => {
    expect(toSample(msg({ error: { message: "boom" } }))).toBeNull();
  });

  it("excludes finish:error even without an error object", () => {
    expect(toSample(msg({ error: undefined, finish: "error" }))).toBeNull();
  });
});

describe("summarize", () => {
  it("weights 100t/2s + 100t/8s as 20 t/s, not the mean of rates", () => {
    const samples = collectSamples([
      msg({ id: "a", time: { created: 0, completed: 2000 } }),
      msg({ id: "b", time: { created: 0, completed: 8000 } }),
    ]);
    const summary = summarize(samples);
    expect(summary.weightedTps).toBe(20);
    expect(summary.count).toBe(2);
    expect(summary.totalReasoning).toBe(40);
  });

  it("returns null weighted TPS when empty", () => {
    expect(summarize([]).weightedTps).toBeNull();
  });

  it("marks total reasoning unknown when any sample omits it", () => {
    const samples = collectSamples([
      msg({ id: "ok", tokens: { output: 100, reasoning: 5 }, time: { created: 0, completed: 2000 } }),
      msg({ id: "unknown", tokens: { output: 100 }, time: { created: 0, completed: 2000 } }),
    ]);
    const summary = summarize(samples);
    expect(samples).toHaveLength(2);
    expect(summary.totalReasoning).toBeNull();
    // Output aggregate stays exact: only reasoning is partial.
    expect(summary.weightedTps).toBe(50);
  });

  it("skips invalid entries without contaminating totals", () => {
    const samples = collectSamples([
      msg({ id: "ok", time: { created: 0, completed: 2000 } }),
      msg({ id: "bad", tokens: { output: -5, reasoning: 0 }, time: { created: 0, completed: 1000 } }),
    ]);
    expect(samples).toHaveLength(1);
    expect(summarize(samples).weightedTps).toBe(50);
  });
});

describe("formatTps", () => {
  it("renders unknown as an em dash", () => {
    expect(formatTps(null)).toBe("—");
    expect(formatTps(undefined)).toBe("—");
  });
});

describe("formatTokens", () => {
  it("renders unknown counts as an em dash, never zero", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(7)).toBe("7");
  });
});
