import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dashboardViewPolicy,
  firstListboxActive,
  lastListboxActive,
  listboxKeyboard,
  listboxOptionID,
  moveListboxActive,
  nextListboxScrollTop,
  reconcileListboxActive,
  simpleSummaryPresentation,
  splitFormattedRate,
  toolbarStatePresentation,
  trendAxis,
  trendPointX,
  trendPointY,
  TREND_Y_BOTTOM,
  TREND_Y_TOP,
  typeaheadListboxActive,
  type ListboxOption,
} from "../src/dashboard.js";
import { catalogs, normalizeLanguage, placeholders, t, viewModeFromStoreValue } from "../src/i18n.js";
import { summarize, type TpsSample, type TpsSummary } from "../src/metrics.js";
import { trendPoints } from "../src/presentation.js";
import { normalizeViewMode } from "../src/definition.js";

function sample(overrides: Partial<TpsSample> = {}): TpsSample {
  return {
    id: "sample",
    agent: "build",
    model: "acme/fast",
    output: 100,
    reasoning: 0,
    created: 1000,
    streamed: 2000,
    completed: 3000,
    durationMs: 2000,
    activeDurationMs: 1000,
    generated: 100,
    tps: 50,
    wallTps: 50,
    primaryTps: 50,
    ...overrides,
  };
}

function summary(overrides: Partial<TpsSummary> = {}): TpsSummary {
  return {
    count: 1,
    totalOutput: 100,
    totalReasoning: 0,
    totalDurationMs: 2000,
    weightedTps: 50,
    weightedPrimaryTps: 50,
    activeCount: 1,
    totalGenerated: 100,
    totalActiveDurationMs: 1000,
    last: sample(),
    lastCompleted: null,
    completedCount: 1,
    failedCount: 0,
    unfinishedCount: 0,
    ...overrides,
  };
}

describe("view-mode preference and presentation policy", () => {
  it("normalizes invalid modes to Simple and retains explicit Detailed", () => {
    expect(normalizeViewMode("simple")).toBe("simple");
    expect(normalizeViewMode("detailed")).toBe("detailed");
    expect(normalizeViewMode("Detailed")).toBe("simple");
    expect(normalizeViewMode("")).toBe("simple");
    expect(normalizeViewMode(undefined)).toBe("simple");
    expect(normalizeViewMode(null)).toBe("simple");
    expect(normalizeViewMode({ mode: "detailed" })).toBe("simple");
    expect(normalizeViewMode(1)).toBe("simple");
  });

  it("reads legacy and explicit store shapes without losing language or live flags", () => {
    expect(viewModeFromStoreValue(undefined)).toBe("simple");
    expect(viewModeFromStoreValue(null)).toBe("simple");
    expect(viewModeFromStoreValue({ language: "es" })).toBe("simple");
    expect(viewModeFromStoreValue({ language: "es", liveEstimate: false })).toBe("simple");
    expect(viewModeFromStoreValue({ viewMode: "detailed" })).toBe("detailed");
    expect(viewModeFromStoreValue({ language: "en", viewMode: "bogus" })).toBe("simple");
    expect(viewModeFromStoreValue("detailed")).toBe("detailed");
    expect(viewModeFromStoreValue("simple")).toBe("simple");
  });

  it("keeps the retained Detailed subtree mounted but hidden in Simple", () => {
    expect(dashboardViewPolicy("simple")).toEqual({
      mode: "simple",
      simple: true,
      detailed: false,
      detailedHidden: true,
    });
    expect(dashboardViewPolicy("detailed")).toEqual({
      mode: "detailed",
      simple: false,
      detailed: true,
      detailedHidden: false,
    });
    expect(dashboardViewPolicy("unknown").mode).toBe("simple");
    expect(dashboardViewPolicy(undefined).detailedHidden).toBe(true);
  });

  it("decodes the real schema for legacy, explicit and default preferences", () => {
    const script = [
      'import { Schema } from "effect";',
      'import { PrefsSchema } from "./src/prefs.ts";',
      'const legacy = Schema.decodeUnknownSync(PrefsSchema)({ language: "es" });',
      'const legacyOff = Schema.decodeUnknownSync(PrefsSchema)({ language: "en", liveEstimate: false });',
      'const explicit = Schema.decodeUnknownSync(PrefsSchema)({ language: "es", liveEstimate: false, viewMode: "detailed" });',
      'const defaults = Schema.decodeUnknownSync(PrefsSchema)({ language: "en", liveEstimate: true, viewMode: "simple" });',
      'console.log(JSON.stringify({ legacy, legacyOff, explicit, defaults }));',
    ].join("\n");
    const output = execFileSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      legacy: { language: "es", liveEstimate: true, viewMode: "simple" },
      legacyOff: { language: "en", liveEstimate: false, viewMode: "simple" },
      explicit: { language: "es", liveEstimate: false, viewMode: "detailed" },
      defaults: { language: "en", liveEstimate: true, viewMode: "simple" },
    });
  });
});

describe("concise Simple summary", () => {
  it("splits localized values from secondary units and keeps unavailable honest", () => {
    expect(splitFormattedRate("50.0 tokens/s")).toEqual({
      value: "50.0",
      unit: "tokens/s",
      available: true,
    });
    expect(splitFormattedRate("—", false)).toEqual({ value: "—", unit: "", available: false });
  });

  it("uses the latest-measurement policy and the shared weighted arithmetic", () => {
    const older = sample({ id: "older", completed: 5000, primaryTps: 50, wallTps: 16 });
    const presentation = simpleSummaryPresentation(
      summary({
        last: older,
        lastCompleted: { id: "newer", model: "acme/B", completed: 8000 } as never,
        activeCount: 1,
        completedCount: 2,
        weightedPrimaryTps: 50,
      }),
      "this session",
      "en",
    );
    // The newest response is unmeasured: no older rate is borrowed.
    expect(presentation.last).toEqual({ value: "—", unit: "", available: false });
    expect(presentation.last.value).not.toMatch(/\d/);
    expect(presentation.weighted).toEqual({ value: "50.0", unit: "tokens/s", available: true });
    expect(presentation.lastHint).toMatch(/No measured rate/);
    expect(presentation.weightedHint).toMatch(/not an average of rates/);
    expect(presentation.explanation).toMatch(/independent of the approximate live estimate/);
    expect(Object.keys(presentation)).not.toContain("wall");
    expect(Object.keys(presentation)).not.toContain("counters");
  });

  it("keeps a measured zero valid and a missing weighted pair unavailable", () => {
    const zero = simpleSummaryPresentation(
      summary({ last: sample({ primaryTps: 0, wallTps: 0 }), weightedPrimaryTps: 0, activeCount: 1 }),
      "this session",
      "en",
    );
    expect(zero.last).toEqual({ value: "0.0", unit: "tokens/s", available: true });
    expect(zero.weighted).toEqual({ value: "0.0", unit: "tokens/s", available: true });

    const missing = simpleSummaryPresentation(
      summary({ last: null, lastCompleted: null, weightedPrimaryTps: null, activeCount: 0 }),
      "this session",
      "en",
    );
    expect(missing.last.available).toBe(false);
    expect(missing.weighted.available).toBe(false);
    expect(missing.weightedHint).toMatch(/No measured provider-active responses/);
  });

  it("never shows a numeric rate while availability is false", () => {
    // Real data flow: summarize() leaves weightedPrimaryTps null when there
    // is no measured active pair, so the normal path is already safe.
    const wallOnly = summarize([sample({ primaryTps: null, generated: null, activeDurationMs: null })]);
    expect(wallOnly.activeCount).toBe(0);
    expect(wallOnly.weightedPrimaryTps).toBeNull();
    const real = simpleSummaryPresentation(wallOnly, "this session", "en");
    expect(real.weighted.available).toBe(false);
    expect(real.weighted.value).toBe("—");
    expect(real.weighted.value).not.toMatch(/\d/);

    // Defensive boundary: a hand-built inconsistent summary cannot leak a
    // finite rate under an unavailable flag.
    const inconsistent = simpleSummaryPresentation(
      summary({ last: null, lastCompleted: null, activeCount: 0, weightedPrimaryTps: 50 }),
      "this session",
      "en",
    );
    expect(inconsistent.weighted.available).toBe(false);
    expect(inconsistent.weighted.value).toBe("—");
  });

  it("localizes the concise copy without translating the scope data", () => {
    const presentation = simpleSummaryPresentation(summary(), "«Mi tarea»", "es");
    expect(presentation.lastLabel).toBe("Última respuesta");
    expect(presentation.weightedLabel).toBe("Promedio ponderado");
    expect(presentation.scopeNote).toBe("Solo «Mi tarea»");
    expect(presentation.weightedHint).toContain("no es un promedio de velocidades");
    expect(presentation.explanation).toContain("estimación en vivo");
    expect(presentation.lastHint).toContain("«Mi tarea»");
  });
});

describe("trend axis and response-order layout", () => {
  it("scales to the measured peak and excludes missing values", () => {
    const points = trendPoints([
      sample({ id: "a", completed: 1000, primaryTps: 10 }),
      sample({ id: "b", completed: 2000, primaryTps: 20 }),
      sample({ id: "c", completed: 3000, primaryTps: null }),
    ]);
    expect(points.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(trendAxis(points)).toEqual({ max: 20, mid: 10, measured: 2, allZero: false });
    expect(trendPointY(20, 20)).toBe(TREND_Y_TOP);
    expect(trendPointY(10, 20)).toBe(50);
    expect(trendPointY(0, 20)).toBe(TREND_Y_BOTTOM);
    expect(trendPointY(null, 20)).toBeNull();
  });

  it("labels all-zero honestly and keeps empty or all-unmeasured distinct", () => {
    const zero = trendPoints([
      sample({ id: "a", completed: 1000, primaryTps: 0 }),
      sample({ id: "b", completed: 2000, primaryTps: 0 }),
    ]);
    expect(trendAxis(zero)).toEqual({ max: 0, mid: null, measured: 2, allZero: true });
    // A zero axis stays on the baseline; it never invents a positive floor.
    expect(trendPointY(0, 0)).toBe(TREND_Y_BOTTOM);
    expect(trendPointY(10, 0)).toBe(TREND_Y_BOTTOM);

    const unmeasured = trendPoints([
      sample({ id: "a", completed: 1000, primaryTps: null }),
      sample({ id: "b", completed: 2000, primaryTps: null }),
    ]);
    expect(trendAxis(unmeasured)).toEqual({ max: 0, mid: null, measured: 0, allZero: false });
    expect(trendAxis([])).toEqual({ max: 0, mid: null, measured: 0, allZero: false });
  });

  it("keeps a single response meaningful and spaces points by response order", () => {
    const one = trendPoints([sample({ id: "only", completed: 1000, primaryTps: 12 })]);
    expect(trendAxis(one)).toEqual({ max: 12, mid: 6, measured: 1, allZero: false });
    expect(trendPointX(0, 1)).toBe(50);

    // Wide wall-clock spacing does not widen an x interval.
    const spaced = trendPoints([
      sample({ id: "a", completed: 1000, primaryTps: 10 }),
      sample({ id: "b", completed: 9000, primaryTps: 20 }),
      sample({ id: "c", completed: 10000, primaryTps: 30 }),
    ]);
    expect(spaced.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect([0, 1, 2].map((index) => trendPointX(index, 3))).toEqual([2, 50, 98]);
    expect(trendPointX(0, 30)).toBe(2);
    expect(trendPointX(29, 30)).toBe(98);
  });

  it("localizes the visible title, axes and honest zero/missing copy", () => {
    expect(t("en", "trend.title")).toBe("Provider-active generated tokens/s");
    expect(t("es", "trend.title")).toBe("Velocidad proveedor-activa (tokens generados/s)");
    expect(t("en", "trend.axisX")).toBe("Response order");
    expect(t("es", "trend.axisX")).toBe("Orden de respuestas");
    expect(t("en", "trend.axisOlder")).toBe("older");
    expect(t("es", "trend.axisNewer")).toBe("más reciente");
    expect(t("en", "trend.allZero")).toMatch(/0 tokens\/s/);
    expect(t("es", "trend.allZero")).toMatch(/0 tokens\/s/);
    expect(t("en", "trend.unmeasured")).toMatch(/not plotted as zero/);
    expect(t("es", "trend.unmeasured")).toMatch(/no se dibujan como cero/);
    expect(t("en", "panel.scrollAria")).toBe("Scrollable TPSTracer panel");
    expect(t("es", "panel.scrollAria")).toBe("Panel desplazable de TPSTracer");
  });
});

describe("panel scroll owner and full-width trend contract", () => {
  const gui = readFileSync(new URL("../src/gui.tsx", import.meta.url), "utf8");
  const view = readFileSync(new URL("../src/view.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/panel.css", import.meta.url), "utf8");

  it("uses one constrained, named panel scroll owner", () => {
    expect(gui.match(/class="tps-panel-scroll"/g)).toHaveLength(1);
    expect(gui).toContain('role="region"');
    expect(gui).toContain('tabindex="0"');
    expect(gui).toContain("panel.scrollAria");
    const block = css.slice(
      css.indexOf(".tps-panel-scroll {"),
      css.indexOf("}", css.indexOf(".tps-panel-scroll {")) + 1,
    );
    expect(block).toContain("height: 100%");
    expect(block).toContain("min-height: 0");
    expect(block).toContain("overflow-y: auto");
    expect(block).toContain("overflow-x: clip");
    expect(block).not.toContain("100vh");
    expect(block).not.toContain("max-height");

    // The inner root has no overflow of its own: a horizontal-only rule would
    // compute overflow-y:auto and create a nested vertical scroll container.
    const rootStart = css.indexOf("\n.tps-root {", css.indexOf(".tps-panel-scroll:focus-visible"));
    const root = css.slice(rootStart, css.indexOf("}", rootStart) + 1);
    expect(root).not.toContain("overflow-x:");
    expect(root).not.toContain("overflow-y:");

    // Local list/table scrollers stay contained and independent.
    expect(css).toContain(".tps-menu-list");
    expect(css).toContain("max-height: 240px");
    expect(css).toContain(".tps-table-wrap");
    expect(css).toContain("max-height: 420px");
    expect(css).toContain("overflow: auto");
  });

  it("stretches the plot across its width with labels outside the SVG", () => {
    expect(view).toContain('preserveAspectRatio="none"');
    expect(view).toContain('vector-effect="non-scaling-stroke"');
    expect(view).toContain('class="tps-chart-plot"');
    expect(view).toContain('class="tps-trend"');
    expect(view).toContain("trend.title");
    expect(view).toContain("trend.description");
    expect(view).toContain("trend.legend");
    expect(view).toContain("trend.unit");
    expect(view).toContain("trend.axisX");
    expect(view).toContain("trend.axisOlder");
    expect(view).toContain("trend.axisNewer");
    expect(view).toContain("trend.allZero");
    expect(view).not.toContain('viewBox="0 0 100 36"');
    expect(view.indexOf("tps-chart-y")).toBeLessThan(view.indexOf("<svg"));
    expect(view.indexOf("tps-chart-x")).toBeGreaterThan(view.indexOf("</svg>"));

    const block = css.slice(css.indexOf(".tps-trend {"), css.indexOf("}", css.indexOf(".tps-trend {")) + 1);
    expect(block).toContain("width: 100%");
    expect(block).toContain("height: 100%");
    const plot = css.slice(css.indexOf(".tps-chart-plot {"), css.indexOf("}", css.indexOf(".tps-chart-plot {")) + 1);
    expect(plot).toContain("min-width: 0");
    expect(plot).toContain("height: clamp(");
    expect(css).not.toContain("aspect-ratio");
  });
});

describe("quiet healthy toolbar", () => {
  it("renders no healthy Connected or Throughput label", () => {
    const healthy = toolbarStatePresentation(true, false, "en");
    expect(healthy.text).toBeNull();
    expect(healthy.tone).toBeNull();
    expect(healthy.exceptional).toBe(false);
    expect(healthy.text).not.toBe("Connected");
    expect(healthy.text).not.toBe("Throughput");
  });

  it("keeps disconnected and partial exceptional states discoverable", () => {
    expect(toolbarStatePresentation(false, false, "en")).toEqual({
      text: "Disconnected",
      tone: "bad",
      exceptional: true,
    });
    expect(toolbarStatePresentation(true, true, "en")).toEqual({
      text: "Partial",
      tone: "warn",
      exceptional: true,
    });
    expect(toolbarStatePresentation(false, true, "es")).toMatchObject({
      text: "Desconectado",
      tone: "bad",
    });
    expect(toolbarStatePresentation(true, true, "es")).toMatchObject({
      text: "Parcial",
      tone: "warn",
    });
  });
});

const listOptions: readonly ListboxOption[] = [
  { value: "root", label: "Current session", detail: "Selected session" },
  { value: "c1", label: "«Alpha»" },
  { value: "c2", label: "Beta", disabled: true },
  { value: "c3", label: "Gamma" },
];

describe("selection listbox state helpers", () => {
  it("reconciles an active option when inventory changes without committing", () => {
    expect(reconcileListboxActive(listOptions, null, "root")).toBe("root");
    expect(reconcileListboxActive(listOptions, "c1", "root")).toBe("c1");
    expect(reconcileListboxActive(listOptions, "gone", "c3")).toBe("c3");
    expect(reconcileListboxActive(listOptions, "gone", "also-gone")).toBe("root");
    expect(reconcileListboxActive(listOptions, "c2", null)).toBe("root");
    expect(reconcileListboxActive([{ value: "off", label: "Off", disabled: true }], null, "off")).toBeNull();
    expect(listboxOptionID("scope", "c3", listOptions)).toBe("scope-option-3");
    expect(listboxOptionID("scope", "gone", listOptions)).toBeUndefined();
  });

  it("moves with wrap-around and skips disabled options", () => {
    expect(moveListboxActive(listOptions, "root", 1)).toBe("c1");
    expect(moveListboxActive(listOptions, "c1", 1)).toBe("c3");
    expect(moveListboxActive(listOptions, "c3", 1)).toBe("root");
    expect(moveListboxActive(listOptions, "root", -1)).toBe("c3");
    expect(moveListboxActive(listOptions, null, 1)).toBe("root");
    expect(moveListboxActive(listOptions, null, -1)).toBe("c3");
    expect(firstListboxActive(listOptions)).toBe("root");
    expect(lastListboxActive(listOptions)).toBe("c3");
  });

  it("implements arrows, Home/End, Enter/Space, Escape, Tab and typeahead", () => {
    expect(listboxKeyboard("ArrowDown", listOptions, "root")).toMatchObject({
      handled: true,
      activeValue: "c1",
      close: false,
    });
    expect(listboxKeyboard("ArrowUp", listOptions, "root")).toMatchObject({ activeValue: "c3" });
    expect(listboxKeyboard("Home", listOptions, "c3")).toMatchObject({ activeValue: "root" });
    expect(listboxKeyboard("End", listOptions, "root")).toMatchObject({ activeValue: "c3" });

    expect(listboxKeyboard("Enter", listOptions, "c1")).toEqual({
      handled: true,
      close: true,
      focusTrigger: true,
      activeValue: "c1",
      commitValue: "c1",
    });
    expect(listboxKeyboard(" ", listOptions, "root")).toMatchObject({
      handled: true,
      close: true,
      focusTrigger: true,
      commitValue: "root",
    });
    // A disabled or vanished active option never commits.
    expect(listboxKeyboard("Enter", listOptions, "c2")).toMatchObject({
      handled: true,
      close: false,
      commitValue: null,
    });

    expect(listboxKeyboard("Escape", listOptions, "c1")).toEqual({
      handled: true,
      close: true,
      focusTrigger: true,
      activeValue: "c1",
      commitValue: null,
    });
    // Tab dismisses and returns focus to the trigger without trapping the key.
    expect(listboxKeyboard("Tab", listOptions, "c1")).toEqual({
      handled: false,
      close: true,
      focusTrigger: true,
      activeValue: "c1",
      commitValue: null,
    });

    expect(typeaheadListboxActive(listOptions, "c3", "c")).toBe("root");
    expect(typeaheadListboxActive(listOptions, "root", "g")).toBe("c3");
    expect(typeaheadListboxActive(listOptions, "root", "b")).toBeNull();
    expect(listboxKeyboard("g", listOptions, "root")).toMatchObject({
      handled: true,
      activeValue: "c3",
      commitValue: null,
    });
    expect(listboxKeyboard("x", listOptions, "root")).toMatchObject({ handled: false });
  });

  it("does not commit or throw when no options remain", () => {
    expect(moveListboxActive([], null, 1)).toBeNull();
    expect(firstListboxActive([])).toBeNull();
    expect(lastListboxActive([])).toBeNull();
    expect(typeaheadListboxActive([], null, "a")).toBeNull();
    expect(listboxKeyboard("Enter", [], null)).toMatchObject({
      handled: true,
      close: false,
      commitValue: null,
    });
    expect(listboxKeyboard("ArrowDown", [], null)).toMatchObject({
      handled: true,
      activeValue: null,
    });
  });
});

describe("contained listbox scroll", () => {
  const base = { listTop: 100, listBottom: 300, scrollTop: 50 };

  it("leaves a fully visible option alone and scrolls only the list", () => {
    expect(nextListboxScrollTop({ ...base, optionTop: 120, optionBottom: 140 })).toBe(50);
    expect(nextListboxScrollTop({ ...base, optionTop: 80, optionBottom: 100 })).toBe(28);
    expect(nextListboxScrollTop({ ...base, optionTop: 290, optionBottom: 320 })).toBe(72);
    expect(nextListboxScrollTop({ ...base, optionTop: 0, optionBottom: 50, scrollTop: 0 })).toBe(0);
  });

  it("honors the inset margin and a tall option", () => {
    expect(
      nextListboxScrollTop({ ...base, optionTop: 100, optionBottom: 102, margin: 0 }),
    ).toBe(50);
    expect(
      nextListboxScrollTop({ listTop: 100, listBottom: 200, scrollTop: 0, optionTop: 120, optionBottom: 320 }),
    ).toBe(122);
  });
});

describe("catalog and control contracts", () => {
  it("keeps new English/Spanish keys and placeholders in parity", () => {
    for (const key of [
      "view.modeLabel",
      "view.simple",
      "view.detailed",
      "menu.empty",
      "simple.aria",
      "simple.lastHint",
      "simple.weightedHint",
      "simple.lastUnavailable",
      "simple.weightedUnavailable",
      "simple.explanation",
      "live.approxShort",
      "panel.scrollAria",
      "trend.title",
      "trend.description",
      "trend.legend",
      "trend.unit",
      "trend.axisX",
      "trend.axisOlder",
      "trend.axisNewer",
      "trend.allZero",
      "trend.unmeasured",
    ] as const) {
      expect(catalogs.es[key], `missing Spanish ${key}`).toBeTruthy();
      expect(placeholders(catalogs.es[key]), `params for ${key}`).toEqual(
        placeholders(catalogs.en[key]),
      );
    }
    expect(t("es", "view.simple")).toBe("Simple");
    expect(t("es", "view.detailed")).toBe("Detallada");
    expect(t("es", "scope.label")).toBe("Sesión");
    expect(t("es", "hero.last")).toBe("Última respuesta");
    expect(t("es", "hero.weighted")).toBe("Promedio ponderado");
    expect(t("es", "simple.weightedHint")).toContain("no es un promedio de velocidades");
    expect(t("es", "simple.explanation")).toContain("estimación en vivo");
    expect(t("es", "live.approxShort")).toBe(
      "Aproximado a partir de la salida visible; las métricas finales no cambian.",
    );
    expect(normalizeLanguage("xx")).toBe("en");
  });

  it("uses only the custom accessible controls, not native open selects", () => {
    const view = readFileSync(new URL("../src/view.tsx", import.meta.url), "utf8");
    const controls = readFileSync(new URL("../src/controls.tsx", import.meta.url), "utf8");
    expect(view).not.toContain("<select");
    expect(view).not.toContain("tps-select");
    expect(view).not.toContain("LanguageSelect");
    expect(controls).not.toContain("<select");
    expect(view).toContain("SelectionPopover");
    expect(view).toContain("ViewModeControl");
    expect(view).toContain("LiveEstimateSwitch");
    expect(controls).toContain('role="listbox"');
    expect(controls).toContain('role="option"');
    expect(controls).toContain('role="switch"');
    expect(controls).toContain("aria-activedescendant");
    expect(controls).toContain("aria-haspopup=\"listbox\"");
    expect(controls).toContain("aria-expanded");
    expect(controls).toContain("aria-checked");
    expect(controls).toContain("aria-pressed");
    expect(controls).toContain("aria-disabled");
    expect(controls).toContain("document.addEventListener(\"pointerdown\"");
    expect(controls).toContain("document.removeEventListener(\"pointerdown\"");
  });

  it("centers a shared inline-SVG chevron and scrolls only the list", () => {
    const controls = readFileSync(new URL("../src/controls.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/panel.css", import.meta.url), "utf8");
    expect(controls).not.toContain("⌄");
    expect(controls).toContain('class="tps-menu-chevron"');
    expect(controls).toContain('viewBox="0 0 10 6"');
    expect(controls).toContain('aria-hidden="true"');
    expect(controls).toContain("nextListboxScrollTop");
    expect(controls).toContain("scrollActiveIntoView");
    expect(controls).toContain("getBoundingClientRect");
    expect(controls).toContain("list.scrollTop");
    expect(controls).toContain("clientHeight <= 0");
    expect(controls).toContain("disposed");
    expect(controls).not.toContain("scrollIntoView(");

    expect(css).toContain(".tps-menu-chevron");
    expect(css).toContain(".tps-menu-chevron svg");
    expect(css).toContain("display: inline-flex");
    expect(css).toContain("align-items: center");
    expect(css).toContain("justify-content: center");
    expect(css).toContain("width: 14px");
    expect(css).toContain("height: 14px");
    expect(css).toContain("width: 10px");
    expect(css).toContain("height: 6px");
  });

  it("retains the Detailed subtree and all technical sections while hiding it", () => {
    const view = readFileSync(new URL("../src/view.tsx", import.meta.url), "utf8");
    expect(view).toContain("tps-detailed");
    expect(view).toContain("hidden={view().detailedHidden}");
    expect(view).not.toContain("Show when={view().detailed}");
    expect(view).toContain("SimpleSummary");
    expect(view).toContain("compact={view().simple}");
    expect(view).toContain("ModelOverview");
    expect(view).toContain("HistoryTable");
    expect(view).toContain("TrendChart");
    expect(view).toContain("createSignal<string>(props.tree.rootSessionID)");
    expect(view).toContain("createSignal<AgentSelection>(ALL_AGENTS)");
    expect(view).toContain("createSignal(HISTORY_INITIAL_ROWS)");
  });

  it("removes the healthy toolbar labels and keeps refresh/partial slots", () => {
    const view = readFileSync(new URL("../src/view.tsx", import.meta.url), "utf8");
    expect(view).not.toContain("toolbar.connected");
    expect(view).not.toContain("toolbar.label");
    expect(view).toContain("toolbarStatePresentation");
    expect(view).toContain("PartialFlag");
    expect(view).toContain("tps-sync");
    expect(view).toContain("action.refreshAria");
  });

  it("wires the mode through preferences without touching the tree hook", () => {
    const gui = readFileSync(new URL("../src/gui.tsx", import.meta.url), "utf8");
    const hook = readFileSync(new URL("../src/gui-hook.tsx", import.meta.url), "utf8");
    const prefs = readFileSync(new URL("../src/prefs.ts", import.meta.url), "utf8");
    const view = readFileSync(new URL("../src/view.tsx", import.meta.url), "utf8");
    expect(gui).toContain("viewModeFromStoreValue");
    expect(gui).toContain("draft.viewMode");
    expect(gui).toContain("viewMode={viewMode()}");
    expect(gui).toContain("onViewMode={onViewMode}");
    expect(gui).not.toContain("createEffect");
    expect(hook).not.toContain("viewMode");
    expect(hook).not.toContain("prefs");
    expect(view).not.toMatch(/createEffect\([^)]*view\(\)/s);
    expect(view).not.toMatch(/createEffect\([^)]*props\.lang/s);
    expect(prefs).toContain("withDecodingDefaultKey");
    expect(prefs).toContain("viewMode");
  });

  it("keeps scoped responsive styles and hidden/focus behavior", () => {
    const css = readFileSync(new URL("../src/panel.css", import.meta.url), "utf8");
    expect(css).toContain(".tps-menu-pop");
    expect(css).toContain("max-height: 240px");
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain("@container (max-width: 440px)");
    expect(css).toContain("@container (max-width: 360px)");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain(".tps-switch");
    expect(css).toContain(".tps-mode");
    expect(css).toContain("[hidden]");
    expect(css).toContain("overflow-x: clip");
  });
});
