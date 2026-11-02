import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { TpsSample } from "../src/metrics.js";
import { agentLabel, groupByAgent } from "../src/metrics.js";
import {
  AGENTS_INITIAL_COUNT,
  agentMatches,
  agentSelectionLabel,
  agentSelectionOf,
  ALL_AGENTS,
  hasScopeContent,
  headerBadgePresentation,
  HISTORY_INITIAL_ROWS,
  historyWindow,
  isAgentSelected,
  isKnownScope,
  latestMeasurement,
  limitList,
  modelStatusNote,
  nextModelsVisibleState,
  nextPartialNote,
  normalizeAgentSelection,
  observationsForAgentSelection,
  resolveScope,
  rootScopeLabel,
  samplesForAgentSelection,
  samplesForScope,
  scopeDisplayName,
  scopeOptionsFor,
  scopeRenderPolicy,
  scopeSummary,
  shortModel,
  sortHistoryDesc,
  splitTrendSegments,
  TREND_MAX_POINTS,
  trendPoints,
  type PartialNoteState,
} from "../src/presentation.js";

function sample(id: string, completed: number, tps = 10, agent: string | null = "build"): TpsSample {
  return {
    id,
    agent,
    model: "acme/fast",
    output: 100,
    reasoning: 0,
    created: completed - 2000,
    streamed: completed - 1000,
    completed,
    durationMs: 2000,
    activeDurationMs: 1000,
    generated: 100,
    tps,
    wallTps: tps,
    primaryTps: tps,
  };
}

describe("sortHistoryDesc", () => {
  it("orders newest completion first", () => {
    const out = sortHistoryDesc([sample("a", 1000), sample("b", 3000), sample("c", 2000)]);
    expect(out.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });
});

describe("historyWindow", () => {
  it("shows at most ten rows initially, newest first", () => {
    const samples = Array.from({ length: 15 }, (_, i) => sample(`m${i}`, i * 1000));
    const rows = historyWindow(samples, HISTORY_INITIAL_ROWS);
    expect(HISTORY_INITIAL_ROWS).toBe(10);
    expect(rows).toHaveLength(10);
    expect(rows[0]?.id).toBe("m14");
    expect(rows[9]?.id).toBe("m5");
  });

  it("returns an empty window for non-positive counts", () => {
    expect(historyWindow([sample("a", 1)], 0)).toEqual([]);
  });
});

describe("trendPoints", () => {
  it("keeps chronological order with zero-safe scaling", () => {
    const pts = trendPoints([sample("a", 1000, 10), sample("b", 2000, 20), sample("c", 3000, 0)]);
    expect(pts.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(pts[1]?.ratio).toBe(1);
    expect(pts[0]?.ratio).toBe(0.5);
    expect(pts[2]?.ratio).toBe(0);
  });

  it("handles empty and single-point inputs without NaN", () => {
    expect(trendPoints([])).toEqual([]);
    const [only] = trendPoints([sample("a", 1000, 0)]);
    expect(only?.ratio).toBe(0);
    expect(Number.isFinite(only?.ratio)).toBe(true);
  });

  it("caps at the last thirty samples", () => {
    const samples = Array.from({ length: 40 }, (_, i) => sample(`m${i}`, i));
    const pts = trendPoints(samples);
    expect(TREND_MAX_POINTS).toBe(30);
    expect(pts).toHaveLength(30);
    expect(pts[0]?.id).toBe("m10");
    expect(pts[29]?.id).toBe("m39");
  });

  it("splits measured runs so isolated dots render without bridging", () => {
    const pts = trendPoints([
      { ...sample("a", 1000, 10), primaryTps: 10 },
      { ...sample("b", 2000, 10), primaryTps: null },
      { ...sample("c", 3000, 20), primaryTps: 20 },
    ]);
    expect(pts.map((p) => p.gap)).toEqual([false, true, false]);
    const segs = splitTrendSegments(pts);
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.map((p) => p.id))).toEqual([["a"], ["c"]]);
    // Singletons are dots, not zero-length bridges.
    expect(segs.every((s) => s.length === 1)).toBe(true);
  });
});

describe("latestMeasurement", () => {
  it("prefers the latest completed observation even when unmeasured", () => {
    const measured = { ...sample("older", 5000, 50), model: "acme/A", primaryTps: 50, wallTps: 16 };
    const summary = {
      last: measured,
      lastCompleted: { id: "newer", model: "acme/B", completed: 8000 },
      completedCount: 2,
    } as never;
    const m = latestMeasurement(summary);
    expect(m).toEqual({ hasLatest: true, unmeasured: true, primary: null, wall: null, model: "acme/B" });
  });

  it("uses the measured sample when it is the latest completed", () => {
    const measured = { ...sample("only", 5000, 50), model: "acme/A", primaryTps: 50, wallTps: 16 };
    const summary = {
      last: measured,
      lastCompleted: { id: "only", model: "acme/A", completed: 5000 },
      completedCount: 1,
    } as never;
    expect(latestMeasurement(summary)).toEqual({
      hasLatest: true,
      unmeasured: false,
      primary: 50,
      wall: 16,
      model: "acme/A",
    });
  });

  it("reports no latest when nothing completed", () => {
    expect(latestMeasurement({ last: null, lastCompleted: null } as never)).toEqual({
      hasLatest: false,
      unmeasured: false,
      primary: null,
      wall: null,
      model: null,
    });
  });
});

describe("models visible keeper", () => {
  it("preserves expansion on the same root and resets on root change", () => {
    const start = { root: "r1", visible: 6 };
    expect(nextModelsVisibleState(start, "r1", 6)).toBe(start);
    expect(nextModelsVisibleState({ root: "r1", visible: 12 }, "r1", 6)).toEqual({ root: "r1", visible: 12 });
    expect(nextModelsVisibleState(start, "r2", 6)).toEqual({ root: "r2", visible: 6 });
  });

  it("filters observations by agent with the same rule as samples", () => {
    const obs = [
      { id: "a", agent: "build" },
      { id: "b", agent: "plan" },
    ] as never[];
    expect(observationsForAgentSelection(obs, ALL_AGENTS)).toHaveLength(2);
    expect(observationsForAgentSelection(obs, agentSelectionOf("plan")).map((o) => o.id)).toEqual(["b"]);
  });

  it("resolves the reserved model status line without banner flicker", () => {
    const base = { totalMeasuredActive: 2, totalObserved: 5 };
    const withEntries = { entries: [{ key: "a" }, { key: "b" }], ...base };
    // Entries present: fixed coverage text regardless of loading (toolbar spinner covers background).
    expect(modelStatusNote({ ...withEntries, loading: false, disconnected: false }, "en")).toBe(
      "2 of 5 measured",
    );
    expect(modelStatusNote({ ...withEntries, loading: true, disconnected: false }, "en")).toBe(
      "2 of 5 measured",
    );
    expect(modelStatusNote({ ...withEntries, loading: true, disconnected: false }, "es")).toBe(
      "2 de 5 medidos",
    );
    // Empty states stay honest and short (single reserved line, always mounted).
    expect(modelStatusNote({ entries: [], loading: true, disconnected: false, ...base }, "en")).toBe("Loading models…");
    expect(modelStatusNote({ entries: [], loading: false, disconnected: false, ...base }, "en")).toBe(
      "No models observed yet",
    );
    expect(modelStatusNote({ entries: [], loading: false, disconnected: true, ...base }, "en")).toBe("Disconnected");
  });
});

describe("scopes", () => {
  const samples = [sample("a", 1000, 10, "build"), sample("b", 2000, 20, "plan")];

  it("summarizes exactly one scope without cross-scope totals", () => {
    const summary = scopeSummary(samples);
    // 200t / 4s paired => 50, not the mean of 10 and 20.
    expect(summary.weightedTps).toBe(50);
  });

  it("selects session or single-agent samples", () => {
    expect(samplesForScope(samples, { kind: "session", key: null, label: "s" })).toHaveLength(2);
    expect(
      samplesForScope(samples, { kind: "agent", key: "plan", label: "plan" }).map((s) => s.id),
    ).toEqual(["b"]);
    expect(samplesForScope(samples, { kind: "agent", key: null, label: "unknown" })).toEqual([]);
  });
});

describe("shortModel", () => {
  it("shortens long ids while keeping short ones intact", () => {
    expect(shortModel("acme/fast")).toBe("acme/fast");
    const long = "provider/very-long-model-identifier-with-variant-high";
    expect(shortModel(long).length).toBeLessThan(long.length);
    expect(shortModel(long).endsWith("…")).toBe(true);
  });
});

describe("agent selection", () => {
  const samples = [sample("a", 1000, 10, "all"), sample("b", 2000, 20, "build")];

  it("keeps a real agent literally named all distinct from the all sentinel", () => {
    expect(samplesForAgentSelection(samples, ALL_AGENTS).map((s) => s.id)).toEqual(["a", "b"]);
    expect(samplesForAgentSelection(samples, agentSelectionOf("all")).map((s) => s.id)).toEqual(["a"]);
    expect(agentMatches("all", ALL_AGENTS)).toBe(true);
    expect(agentMatches("build", agentSelectionOf("all"))).toBe(false);
    expect(agentMatches(null, agentSelectionOf(null))).toBe(true);
  });

  it("resets the filter when its agent disappears", () => {
    expect(normalizeAgentSelection(["build"], agentSelectionOf("plan"))).toEqual(ALL_AGENTS);
    expect(normalizeAgentSelection(["plan"], agentSelectionOf("plan"))).toEqual(agentSelectionOf("plan"));
    expect(normalizeAgentSelection([], ALL_AGENTS)).toEqual(ALL_AGENTS);
  });

  it("labels selections without inventing agents", () => {
    // Default is English; Spanish is explicit opt-in.
    expect(agentSelectionLabel(ALL_AGENTS)).toBe("All");
    expect(agentSelectionLabel(agentSelectionOf(null))).toBe("Unknown");
    expect(agentSelectionLabel(ALL_AGENTS, "es")).toBe("Todos");
    expect(agentSelectionLabel(agentSelectionOf(null), "es")).toBe("Desconocido");
    expect(isAgentSelected(agentSelectionOf("build"), "build")).toBe(true);
    expect(isAgentSelected(ALL_AGENTS, "build")).toBe(false);
  });
});

describe("scope resolution", () => {
  const tree = {
    rootSessionID: "root",
    children: [
      { sessionID: "c1", title: "task", agent: "plan", depth: 1 },
      { sessionID: "c2", title: null, agent: null, depth: 1 },
    ],
  };

  it("resolves known scopes and falls back to root when one vanishes", () => {
    expect(resolveScope(tree, "root")).toMatchObject({ sessionID: "root", known: true });
    expect(resolveScope(tree, "c1")).toMatchObject({ sessionID: "c1", known: true, label: "«task»" });
    expect(resolveScope(tree, "gone")).toMatchObject({ sessionID: "root", known: false });
    expect(isKnownScope(tree, "c2")).toBe(true);
    expect(isKnownScope(tree, "gone")).toBe(false);
  });

  it("selects an empty root or a failed child without trapping navigation", () => {
    // Root keeps its neutral name whether or not it has children. Default English.
    expect(scopeDisplayName(tree, "root")).toBe("this session");
    expect(scopeDisplayName({ rootSessionID: "root", children: [] }, "root")).toBe("this session");
    expect(scopeDisplayName(tree, "c2")).toBe("the subagent Unknown");
    expect(scopeDisplayName(tree, "root", "es")).toBe("esta sesión");
    expect(scopeDisplayName({ rootSessionID: "root", children: [] }, "root", "es")).toBe("esta sesión");
    expect(scopeDisplayName(tree, "c2", "es")).toBe("el subagente Desconocido");
    const options = scopeOptionsFor(tree);
    expect(options.map((o) => o.sessionID)).toEqual(["root", "c1", "c2"]);
    expect(options[0]?.label).toBe("Current session");
    expect(scopeOptionsFor(tree, "es")[0]?.label).toBe("Sesión actual");
  });

  it("keeps the neutral root label with zero, one, or many children", () => {
    const empty = { rootSessionID: "root", children: [] };
    const many = {
      rootSessionID: "root",
      children: [
        ...tree.children,
        { sessionID: "c3", title: null, agent: "build", depth: 2 },
      ],
    };
    for (const lang of ["en", "es"] as const) {
      const expectedRoot = lang === "es" ? "Sesión actual" : "Current session";
      const expectedName = lang === "es" ? "esta sesión" : "this session";
      expect(rootScopeLabel(0, lang)).toBe(expectedRoot);
      expect(rootScopeLabel(1, lang)).toBe(expectedRoot);
      expect(rootScopeLabel(3, lang)).toBe(expectedRoot);
      expect(scopeDisplayName(empty, "root", lang)).toBe(expectedName);
      expect(scopeDisplayName(tree, "root", lang)).toBe(expectedName);
      expect(scopeDisplayName(many, "root", lang)).toBe(expectedName);
      expect(resolveScope(many, "root", lang).label).toBe(expectedName);
    }
  });

  it("keeps a real agent named Orchestrator as plain data without special casing", () => {
    const samples = [sample("a", 1000, 10, "Orchestrator"), sample("b", 2000, 20, "my-custom")];
    const groups = groupByAgent(samples);
    expect(groups.map((g) => g.agent)).toEqual(["Orchestrator", "my-custom"]);
    expect(agentLabel("Orchestrator", "en")).toBe("Orchestrator");
    expect(agentLabel("Orchestrator", "es")).toBe("Orchestrator");
    expect(agentLabel("my-custom", "es")).toBe("my-custom");
    expect(groups[0]?.summary.count).toBe(1);
    expect(groups[1]?.summary.count).toBe(1);
  });
});

describe("limitList", () => {
  it("caps progressive agent lists", () => {
    expect(AGENTS_INITIAL_COUNT).toBe(6);
    const list = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(limitList(list, 6)).toHaveLength(6);
    expect(limitList(list, 0)).toEqual([]);
  });
});

describe("scope render policy (stable refresh)", () => {
  const data = [sample("a", 1000, 10), sample("b", 2000, 20)];
  const ready = { status: "ready" as const, samples: data };
  const refreshingSnap = { status: "loading" as const, samples: data };
  const idleStale = { status: "idle" as const, samples: data };

  it("keeps selected content mounted when the root tree reloads", () => {
    // tree loading + selected ready: no loading card, toolbar spinner only.
    const p = scopeRenderPolicy("loading", ready);
    expect(p.showContent).toBe(true);
    expect(p.showLoading).toBe(false);
    expect(p.refreshing).toBe(true);
    expect(hasScopeContent(ready)).toBe(true);
  });

  it("keeps content mounted when the selected scope refreshes with prior samples", () => {
    for (const snap of [refreshingSnap, idleStale]) {
      const p = scopeRenderPolicy("ready", snap);
      expect(p.showContent).toBe(true);
      expect(p.showLoading).toBe(false);
      expect(p.refreshing).toBe(true);
    }
    const both = scopeRenderPolicy("loading", refreshingSnap);
    expect(both.showContent).toBe(true);
    expect(both.showLoading).toBe(false);
    expect(both.refreshing).toBe(true);
  });

  it("shows the designed loading state only for scopes without data", () => {
    for (const status of ["loading", "idle"] as const) {
      const p = scopeRenderPolicy("loading", { status, samples: [] });
      expect(p.showContent).toBe(false);
      expect(p.showLoading).toBe(true);
      expect(p.refreshing).toBe(false);
    }
  });

  it("stays structurally stable across repeated ready/loading alternation", () => {
    const sequence = [
      scopeRenderPolicy("ready", ready),
      scopeRenderPolicy("loading", refreshingSnap),
      scopeRenderPolicy("loading", ready),
      scopeRenderPolicy("ready", ready),
    ];
    // Content and loading-card placement never toggle: only the spinner does.
    expect(sequence.map((p) => p.showContent)).toEqual([true, true, true, true]);
    expect(sequence.map((p) => p.showLoading)).toEqual([false, false, false, false]);
    expect(sequence.map((p) => p.refreshing)).toEqual([false, true, true, false]);
  });

  it("keeps honest empty, error, partial and disconnected semantics", () => {
    const empty = scopeRenderPolicy("ready", { status: "empty", samples: [] });
    expect(empty).toMatchObject({ showContent: false, showLoading: false, refreshing: false });
    const error = scopeRenderPolicy("ready", { status: "error", samples: [] });
    expect(error).toMatchObject({ showContent: false, showLoading: false, refreshing: false });
    const disc = scopeRenderPolicy("disconnected", { status: "disconnected", samples: [] });
    expect(disc).toMatchObject({ showContent: false, showLoading: false, refreshing: false });
    // Stable partial scope: content mounted, no spinner, no loading card.
    const partial = scopeRenderPolicy("ready", { status: "partial", samples: data });
    expect(partial).toMatchObject({ showContent: true, showLoading: false, refreshing: false });
    // Partial scope mid-refresh still keeps content with the spinner only.
    const partialRefresh = scopeRenderPolicy("loading", refreshingSnap);
    expect(partialRefresh.showContent).toBe(true);
    expect(partialRefresh.showLoading).toBe(false);
  });
});

describe("nextPartialNote (sticky partial across refresh)", () => {
  const started: PartialNoteState = { key: "s1", note: "incomplete total" };

  it("retains the honest note while the same scope refreshes", () => {
    // Partial → loading with prior samples → partial: the note does not flicker.
    const during = nextPartialNote(started, "s1", null, true);
    expect(during).toBe(started);
    const back = nextPartialNote(during, "s1", "incomplete total", false);
    expect(back).toEqual({ key: "s1", note: "incomplete total" });
  });

  it("updates and clears the note when not refreshing", () => {
    expect(nextPartialNote(started, "s1", "another note", false)).toEqual({
      key: "s1",
      note: "another note",
    });
    expect(nextPartialNote(started, "s1", null, false)).toEqual({ key: "s1", note: null });
  });

  it("never keeps another scope's note as its own on scope change", () => {
    // Switch to a scope without data: takes the live value (null), even while refreshing.
    expect(nextPartialNote(started, "s2", null, true)).toEqual({ key: "s2", note: null });
    expect(nextPartialNote(started, "s2", "a new note", true)).toEqual({
      key: "s2",
      note: "a new note",
    });
  });

  it("starts empty scopes with no note", () => {
    expect(nextPartialNote({ key: "", note: null }, "s1", null, false)).toEqual({
      key: "s1",
      note: null,
    });
  });
});

describe("headerBadgePresentation (historic value during refresh)", () => {
  const measuredSummary = {
    last: { ...sample("m1", 5000, 50), model: "acme/A", primaryTps: 50, wallTps: 16 },
    lastCompleted: { id: "m1", model: "acme/A", completed: 5000 },
    completedCount: 1,
    weightedPrimaryTps: 50,
  } as never;
  const emptySummary = { last: null, lastCompleted: null, completedCount: 0, weightedPrimaryTps: 0 } as never;

  it("keeps the same primary from ready through loading refresh without ellipsis", () => {
    const ready = headerBadgePresentation(
      { status: "ready", summary: measuredSummary, error: null, reason: null },
      true,
      "en",
    );
    const loading = headerBadgePresentation(
      { status: "loading", summary: measuredSummary, error: null, reason: null },
      true,
      "en",
    );
    expect(ready.text).toBe("50.0 tokens/s");
    expect(ready.refreshing).toBe(false);
    expect(loading.text).toBe(ready.text);
    expect(loading.text).not.toContain("…");
    expect(loading.refreshing).toBe(true);
    // Historic label names the last completed measurement and updating state, never live generation.
    expect(loading.label).toMatch(/Latest completed measurement/);
    expect(loading.label).toContain("50.0 tokens/s");
    expect(loading.label).toMatch(/updating/);
    expect(loading.label).not.toMatch(/generat|Working/);
  });

  it("retains the value across ready, loading and ready again until a new measurement", () => {
    const seq = ["ready", "loading", "ready"].map((status) =>
      headerBadgePresentation({ status, summary: measuredSummary, error: null, reason: null }, true, "en"),
    );
    expect(seq.map((p) => p.text)).toEqual(["50.0 tokens/s", "50.0 tokens/s", "50.0 tokens/s"]);
    expect(seq.map((p) => p.refreshing)).toEqual([false, true, false]);
  });

  it("reserves ellipsis for loading without completed data", () => {
    const loading = headerBadgePresentation(
      { status: "loading", summary: emptySummary, error: null, reason: null },
      true,
      "en",
    );
    expect(loading.text).toBe("TPS …");
    expect(loading.refreshing).toBe(true);
    expect(loading.label).toMatch(/Loading/);
  });

  it("keeps idle without data unavailable without inventing a rate", () => {
    const idle = headerBadgePresentation(
      { status: "idle", summary: emptySummary, error: null, reason: null },
      true,
      "en",
    );
    expect(idle.text).toBe("TPS —");
    expect(idle.refreshing).toBe(false);
  });

  it("applies the same historic policy to idle with retained data", () => {
    const idle = headerBadgePresentation(
      { status: "idle", summary: measuredSummary, error: null, reason: null },
      true,
      "en",
    );
    expect(idle.text).toBe("50.0 tokens/s");
    expect(idle.refreshing).toBe(true);
    expect(idle.label).toMatch(/Latest completed measurement/);
  });

  it("shows unavailable during refresh when the latest completed response is unmeasured", () => {
    const unmeasured = {
      last: { ...sample("older", 5000, 50), model: "acme/A", primaryTps: 50, wallTps: 16 },
      lastCompleted: { id: "newer", model: "acme/B", completed: 8000 },
      completedCount: 2,
      weightedPrimaryTps: 50,
    } as never;
    const loading = headerBadgePresentation(
      { status: "loading", summary: unmeasured, error: null, reason: null },
      true,
      "en",
    );
    // Never an older measured sample, never ellipsis as a value.
    expect(loading.text).toBe("TPS —");
    expect(loading.refreshing).toBe(true);
    expect(loading.label).toMatch(/unmeasured/);
    expect(loading.label).toMatch(/updating/);
  });

  it("never falls back to wall-clock when only wall is measured", () => {
    const wallOnly = {
      last: { ...sample("w1", 5000, 50), model: "acme/A", primaryTps: null, wallTps: 20 },
      lastCompleted: { id: "w1", model: "acme/A", completed: 5000 },
      completedCount: 1,
      weightedPrimaryTps: 0,
    } as never;
    const loading = headerBadgePresentation(
      { status: "loading", summary: wallOnly, error: null, reason: null },
      true,
      "en",
    );
    expect(loading.text).toBe("TPS —");
    expect(loading.text).not.toContain("20.0");
  });

  it("keeps the partial qualifier and never shows stale data for error/disconnected", () => {
    const partial = headerBadgePresentation(
      { status: "partial", summary: measuredSummary, error: null, reason: null },
      true,
      "en",
    );
    expect(partial.text).toBe("50.0 tokens/s~");
    expect(partial.refreshing).toBe(false);
    for (const status of ["error", "disconnected"] as const) {
      const p = headerBadgePresentation(
        { status, summary: measuredSummary, error: "boom", reason: null },
        true,
        "en",
      );
      expect(p.text).toBe("TPS —");
      expect(p.refreshing).toBe(false);
    }
    const offline = headerBadgePresentation(
      { status: "ready", summary: measuredSummary, error: null, reason: null },
      false,
      "en",
    );
    expect(offline.text).toBe("TPS —");
  });

  it("localizes the historic refreshing label in Spanish without live claims", () => {
    const loading = headerBadgePresentation(
      { status: "loading", summary: measuredSummary, error: null, reason: null },
      true,
      "es",
    );
    expect(loading.text).toBe("50,0 tokens/s");
    expect(loading.label).toMatch(/Última medición completada/);
    expect(loading.label).toMatch(/actualizando/);
    expect(loading.label).not.toMatch(/generando|Working/);
    const unmeasuredEs = headerBadgePresentation(
      { status: "loading", summary: emptySummary, error: null, reason: null },
      true,
      "es",
    );
    expect(unmeasuredEs.text).toBe("TPS …");
  });
});

/**
 * Header hover-affordance source contract: the header badge keeps its
 * isolated class, native open behavior and localized accessible label while
 * the shared stylesheet (registered document-wide via the Style registry,
 * so it applies without the panel ever opening) supplies the button-like
 * hover/focus treatment with stable geometry. Source-text level only: no
 * DOM rendering is performed here.
 */
describe("HeaderBadge hover affordance wiring", () => {
  const view = readFileSync(new URL("../src/view.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/panel.css", import.meta.url), "utf8");
  const gui = readFileSync(new URL("../src/gui.tsx", import.meta.url), "utf8");

  it("keeps the isolated class with native open behavior and localized labels", () => {
    expect(view).toContain("tps-header-badge");
    expect(view).toContain("onClick={props.onOpen}");
    expect(view).toContain("title={label()}");
    expect(view).toContain("aria-busy={presentation().refreshing}");
    expect(view).toContain("header.openHint");
  });

  it("styles hover/focus on the isolated class with pointer and visible focus", () => {
    expect(css).toContain(".tps-header-badge");
    expect(css).toContain(".tps-header-badge:hover");
    expect(css).toContain(".tps-header-badge:focus-visible");
    expect(css).toContain("cursor: pointer");
    expect(css).toContain("border-radius: 8px");
  });

  it("keeps geometry constant between normal and hover (no layout shift)", () => {
    const hoverBlock = css.slice(
      css.indexOf(".tps-header-badge:hover"),
      css.indexOf("}", css.indexOf(".tps-header-badge:hover")) + 1,
    );
    expect(hoverBlock).not.toContain("padding");
    expect(hoverBlock).not.toContain("border-width");
    expect(hoverBlock).not.toContain("display");
  });

  it("avoids global button selectors and loads the stylesheet at setup", () => {
    expect(css).not.toMatch(/(^|\n)\s*button[\s,{]/);
    expect(gui).toContain('import panelCss from "./panel.css?inline"');
    expect(gui).toContain("ctx.add(Style, panelCss)");
  });
});
