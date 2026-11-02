import { describe, expect, it } from "vitest";
import { agentLabel, collectSamples, groupByAgent, toSample } from "../src/metrics.js";

function msg(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    agent: "build",
    model: { providerID: "acme", id: "fast" },
    tokens: { input: 10, output: 100, reasoning: 20, cache: { read: 0, write: 0 } },
    time: { created: 1_700_000_000_000, completed: 1_700_000_002_000 },
    finish: "stop",
    ...overrides,
  };
}

describe("agent identity", () => {
  it("retains the per-response agent on the sample", () => {
    expect(toSample(msg({ agent: "plan" }))?.agent).toBe("plan");
  });

  it("keeps unknown agents as null instead of inventing one", () => {
    expect(toSample(msg({ agent: undefined }))?.agent).toBeNull();
    expect(toSample(msg({ agent: 42 }))?.agent).toBeNull();
    expect(toSample(msg({ agent: "" }))?.agent).toBeNull();
  });

  it("labels unknown agents without inventing names", () => {
    expect(agentLabel("build")).toBe("build");
    // Default is English regardless of host locale; Spanish is opt-in.
    expect(agentLabel(null)).toBe("Unknown");
    expect(agentLabel(undefined)).toBe("Unknown");
    expect(agentLabel(null, "es")).toBe("Desconocido");
    expect(agentLabel(undefined, "es")).toBe("Desconocido");
    expect(agentLabel("build", "es")).toBe("build");
  });
});

describe("groupByAgent", () => {
  it("groups samples by retained agent with independent summaries", () => {
    const samples = collectSamples([
      msg({ id: "a1", agent: "build", time: { created: 0, completed: 2000 } }),
      msg({ id: "a2", agent: "plan", time: { created: 0, completed: 4000 } }),
      msg({ id: "a3", agent: "build", time: { created: 0, completed: 2000 } }),
    ]);
    const groups = groupByAgent(samples);
    expect(groups.map((g) => g.agent)).toEqual(["build", "plan"]);
    const build = groups.find((g) => g.agent === "build");
    expect(build?.samples).toHaveLength(2);
    // Each scope summarizes only its own paired tokens/durations:
    // build 200t/4s => 50, plan 100t/4s => 25. Never summed.
    expect(build?.summary.weightedTps).toBe(50);
    expect(groups.find((g) => g.agent === "plan")?.summary.weightedTps).toBe(25);
  });

  it("sorts unknown last and keeps its samples separate", () => {
    const samples = collectSamples([
      msg({ id: "u", agent: undefined, time: { created: 0, completed: 1000 } }),
      msg({ id: "b", agent: "build", time: { created: 0, completed: 1000 } }),
    ]);
    const groups = groupByAgent(samples);
    expect(groups.map((g) => g.agent)).toEqual(["build", null]);
    expect(groups[1]?.summary.count).toBe(1);
  });

  it("returns no groups for no samples", () => {
    expect(groupByAgent([])).toEqual([]);
  });
});
