import { describe, expect, it } from "vitest";
import { summarize } from "../src/metrics.js";
import { buildModelInventory, inventoryFromTree, MODELS_INITIAL_COUNT, MODELS_STEP } from "../src/models.js";
import { limitList } from "../src/presentation.js";
import { catalogs, placeholders, t } from "../src/i18n.js";
import type { AdapterSnapshot } from "../src/adapter.js";
import type { TreeSnapshot } from "../src/orchestrator.js";
import { collectObservations, collectSamples } from "../src/metrics.js";

function snapFor(messages: Record<string, unknown>[]): AdapterSnapshot {
  const assistants = messages as never[];
  const samples = collectSamples(assistants as never);
  const observations = collectObservations(assistants as never);
  return { status: samples.length === 0 ? "empty" : "ready", samples, observations, summary: summarize(samples), error: null };
}

function assistantMsg(id: string, provider: string, model: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: provider, id: model },
    content: [],
    tokens: { input: 1, output: 100, reasoning: 10, cache: { read: 0, write: 0 } },
    time: { created: 0, streamed: 1000, completed: 2000 },
    finish: "stop",
    ...extra,
  };
}

function treeWith(children: TreeSnapshot["children"], rootMsgs: Record<string, unknown>[], partial = false): TreeSnapshot {
  const root = snapFor(rootMsgs);
  return {
    status: partial ? "partial" : "ready",
    rootSessionID: "root",
    rootTitle: null,
    rootAgent: null,
    root,
    children,
    partial,
    error: partial ? "partial" : null,
  };
}

describe("model inventory across root and descendants", () => {
  it("includes models A, B and C with provenance, independent of selection", () => {
    const tree = treeWith(
      [
        { sessionID: "c1", title: "task one", agent: "plan", depth: 1, parentID: "root", snapshot: snapFor([assistantMsg("m1", "p", "B")]) },
        { sessionID: "c2", title: null, agent: "explore", depth: 1, parentID: "root", snapshot: snapFor([assistantMsg("m2", "p", "C")]) },
      ],
      [assistantMsg("r1", "p", "A")],
    );
    const inv = inventoryFromTree("srv", tree);
    expect(inv.entries.map((e) => e.label).sort()).toEqual(["p/A", "p/B", "p/C"]);
    expect(inv.partial).toBe(false);
    expect(inv.scopeCount).toBe(3);
    const b = inv.entries.find((e) => e.label === "p/B")!;
    expect(b.sessions.map((s) => s.sessionID)).toEqual(["c1"]);
    expect(b.sessions[0]).toMatchObject({ title: "task one", agent: "plan" });
    // Pooled per-model rate, not a tree total: inventory itself carries no combined TPS.
    expect((inv as unknown as Record<string, unknown>).weightedPrimaryTps).toBeUndefined();
    expect(b.weightedPrimaryTps).toBe(110);
  });

  it("represents a delegate that changed models in both groups", () => {
    const tree = treeWith(
      [
        {
          sessionID: "c1",
          title: null,
          agent: "plan",
          depth: 1,
          parentID: "root",
          snapshot: snapFor([assistantMsg("m1", "p", "B"), assistantMsg("m2", "p", "C")]),
        },
      ],
      [],
    );
    const inv = inventoryFromTree("srv", tree);
    expect(inv.entries.map((e) => e.label).sort()).toEqual(["p/B", "p/C"]);
    for (const e of inv.entries) {
      expect(e.sessions.map((s) => s.sessionID)).toEqual(["c1"]);
    }
  });

  it("retains failed and missing-usage rows as observed but unmeasured", () => {
    const inv = buildModelInventory([
      {
        serverID: "srv",
        sessionID: "root",
        title: null,
        agent: null,
        snapshot: {
          status: "ready",
          samples: [],
          observations: [
            { id: "bad", agent: "build", model: "p/B", provider: "p", modelId: "B", output: null, reasoning: null, created: 0, streamed: null, completed: null, failed: true },
            { id: "ok", agent: "build", model: "p/B", provider: "p", modelId: "B", output: 100, reasoning: 10, created: 0, streamed: 1000, completed: 2000, failed: false },
          ],
          summary: summarize([]),
          error: null,
        },
      },
    ]);
    const b = inv.entries.find((e) => e.label === "p/B")!;
    expect(b.observed).toBe(2);
    expect(b.measuredWall).toBe(0);
    expect(b.measuredActive).toBe(0);
    // No invented zeros for unmeasured-only totals.
    expect(b.totalOutput).toBeNull();
    expect(b.totalReasoning).toBeNull();
    expect(b.totalGenerated).toBeNull();
    expect(b.weightedPrimaryTps).toBeNull();
    expect(b.weightedWallTps).toBeNull();
  });

  it("keeps equal message ids in different scopes distinct and dedupes repeats", () => {
    const sameIdRoot = snapFor([assistantMsg("m1", "p", "A")]);
    const sameIdChild = snapFor([assistantMsg("m1", "p", "A")]);
    const inv = buildModelInventory([
      { serverID: "srv", sessionID: "root", title: null, agent: null, snapshot: sameIdRoot },
      { serverID: "srv", sessionID: "c1", title: null, agent: null, snapshot: sameIdChild },
    ]);
    const a = inv.entries.find((e) => e.label === "p/A")!;
    // Same id in two scopes: two observations, two measurements (no cross-scope drop).
    expect(a.observed).toBe(2);
    expect(a.measuredWall).toBe(2);

    // Repeating the same triple does not double count.
    const dup = buildModelInventory([
      { serverID: "srv", sessionID: "root", title: null, agent: null, snapshot: sameIdRoot },
      { serverID: "srv", sessionID: "root", title: null, agent: null, snapshot: sameIdRoot },
    ]);
    expect(dup.entries.find((e) => e.label === "p/A")!.observed).toBe(1);
  });

  it("weights pooled per-model rates instead of averaging or summing", () => {
    const s1 = { ...assistantMsg("m1", "p", "A"), tokens: { input: 1, output: 80, reasoning: 20, cache: { read: 0, write: 0 } }, time: { created: 0, streamed: 2000, completed: 5000 } };
    const s2 = { ...assistantMsg("m2", "p", "A"), tokens: { input: 1, output: 90, reasoning: 10, cache: { read: 0, write: 0 } }, time: { created: 0, streamed: 8000, completed: 10000 } };
    const inv = buildModelInventory([
      { serverID: "srv", sessionID: "root", title: null, agent: null, snapshot: snapFor([s1, s2]) },
    ]);
    const a = inv.entries[0]!;
    expect(a.weightedPrimaryTps).toBe(20);
    expect(a.weightedPrimaryTps).not.toBe(31.25);
  });

  it("marks partial discovery and child errors honestly", () => {
    const errChild = {
      sessionID: "c1",
      title: null,
      agent: null,
      depth: 1,
      parentID: "root",
      snapshot: { status: "error" as const, samples: [], observations: [], summary: summarize([]), error: "down", reason: null },
    };
    const tree = treeWith([errChild], [assistantMsg("r1", "p", "A")], true);
    const inv = inventoryFromTree("srv", tree);
    expect(inv.partial).toBe(true);
  });

  it("starts progressively with six models and expands by step", () => {
    expect(MODELS_INITIAL_COUNT).toBe(6);
    expect(MODELS_STEP).toBe(6);
    const list = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(limitList(list, MODELS_INITIAL_COUNT)).toHaveLength(6);
    expect(limitList(list, 0)).toEqual([]);
  });

  it("derives per-session agents from observations, not scope agent", () => {
    const msgs = [
      { ...assistantMsg("m1", "p", "A"), agent: "build" },
      { ...assistantMsg("m2", "p", "A"), agent: "plan" },
    ];
    const inv = buildModelInventory([
      { serverID: "srv", sessionID: "root", title: null, agent: null, snapshot: snapFor(msgs) },
    ]);
    const a = inv.entries.find((e) => e.label === "p/A")!;
    expect([...a.agents].sort()).toEqual(["build", "plan"]);
    expect(a.sessions).toHaveLength(1);
    expect([...(a.sessions[0]?.agents ?? [])].sort()).toEqual(["build", "plan"]);
  });

  it("keeps same session ids on different servers distinct (composite identity)", () => {
    const snap = snapFor([assistantMsg("m1", "p", "A")]);
    const inv = buildModelInventory([
      { serverID: "srv-a", sessionID: "s", title: null, agent: null, snapshot: snap },
      { serverID: "srv-b", sessionID: "s", title: null, agent: null, snapshot: snap },
    ]);
    const a = inv.entries.find((e) => e.label === "p/A")!;
    expect(a.observed).toBe(2);
    expect(a.sessions).toHaveLength(2);
    expect(a.sessions.map((s) => s.serverID).sort()).toEqual(["srv-a", "srv-b"]);
  });

  it("marks initial loading as in-progress, not complete", () => {
    const loadingSnap = { status: "loading" as const, samples: [], observations: [], summary: summarize([]), error: null };
    const tree = {
      status: "loading" as const,
      rootSessionID: "root",
      rootTitle: null,
      rootAgent: null,
      root: loadingSnap,
      children: [],
      partial: false,
      error: null,
    };
    const inv = inventoryFromTree("srv", tree);
    expect(inv.entries).toHaveLength(0);
    expect(inv.loading).toBe(true);
    expect(inv.partial).toBe(false);
  });

  it("keeps prior entries during background refresh without forcing partial", () => {
    const readySnap = snapFor([assistantMsg("r1", "p", "A")]);
    const refreshingSnap = { ...readySnap, status: "loading" as const };
    const tree = {
      status: "loading" as const,
      rootSessionID: "root",
      rootTitle: null,
      rootAgent: null,
      root: refreshingSnap,
      children: [],
      partial: false,
      error: null,
    };
    const inv = inventoryFromTree("srv", tree);
    expect(inv.entries).toHaveLength(1);
    expect(inv.loading).toBe(true);
    // Refreshing with prior data is updating, not permanently partial:
    // the toolbar spinner covers it, no in-flow banner flicker.
    expect(inv.partial).toBe(false);
  });
});

describe("new copy parity and labels", () => {
  it("keeps English/Spanish catalogs in sync for new keys", () => {
    const enKeys = Object.keys(catalogs.en);
    for (const key of ["hero.secondary", "hero.coverage", "rate.primary", "history.speedWall", "history.active", "section.modelsScope", "models.hint", "models.showMore", "models.measuredUsage", "models.loading", "trend.gap"] as const) {
      expect(enKeys).toContain(key);
      expect(placeholders(catalogs.es[key]!)).toEqual(placeholders(catalogs.en[key]!));
    }
  });

  it("labels primary and wall rates unambiguously in both languages", () => {
    expect(t("en", "rate.primary")).toBe("Provider-active");
    expect(t("es", "rate.primary")).toBe("Proveedor-activo");
    expect(t("en", "rate.secondary")).toBe("Wall-clock");
    expect(t("en", "history.speed")).toBe("Speed · active");
    expect(t("es", "history.active")).toBe("Activa");
    expect(t("en", "section.modelsScope")).toMatch(/all loaded sessions/);
    expect(t("es", "section.modelsScope")).toMatch(/todas las sesiones cargadas/);
  });
});
