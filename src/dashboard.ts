/**
 * Pure dashboard presentation policy.
 *
 * View-mode visibility, the concise Simple summary, quiet-toolbar state and
 * the selection-listbox keyboard reducer live here so they can be exercised
 * exhaustively without a DOM harness. Metric arithmetic stays in metrics.ts;
 * this module only selects and formats values.
 */

import type { Language, TextDirection, ViewMode } from "./definition.js";
import { normalizeLanguage, normalizeViewMode } from "./definition.js";
import type { TpsSummary } from "./metrics.js";
import { formatTps } from "./metrics.js";
import { latestMeasurement, type TrendPoint } from "./presentation.js";
import { t } from "./i18n.js";

export const VIEW_MODES = ["simple", "detailed"] as const satisfies readonly ViewMode[];

export interface DashboardViewPolicy {
  readonly mode: ViewMode;
  readonly simple: boolean;
  readonly detailed: boolean;
  /** The retained Detailed subtree is mounted but hidden in Simple. */
  readonly detailedHidden: boolean;
}

/** Resolve the mode and the retention visibility used by the view. */
export function dashboardViewPolicy(value: unknown): DashboardViewPolicy {
  const mode = normalizeViewMode(value);
  return {
    mode,
    simple: mode === "simple",
    detailed: mode === "detailed",
    detailedHidden: mode !== "detailed",
  };
}

export interface RateParts {
  readonly value: string;
  /** Empty when the value is unavailable, never a fabricated unit. */
  readonly unit: string;
  readonly available: boolean;
}

/** Split a localized `value unit` rate without touching its numeric text. */
export function splitFormattedRate(formatted: string, available = true): RateParts {
  const idx = formatted.lastIndexOf(" ");
  if (idx < 0) return { value: formatted, unit: "", available };
  return { value: formatted.slice(0, idx), unit: formatted.slice(idx + 1), available };
}

/** Percentage insets keep the first/last dots inside the plot without a fixed aspect ratio. */
export const TREND_X_INSET = 2;
export const TREND_Y_TOP = 4;
export const TREND_Y_BOTTOM = 96;

export interface TrendAxis {
  /** Top of the axis: the measured peak, or 0 when nothing positive was measured. */
  readonly max: number;
  /** Mid grid value, omitted for an all-zero window. */
  readonly mid: number | null;
  /** Measured responses in the window (gaps excluded). */
  readonly measured: number;
  /** True when at least one response was measured and every measured rate is 0. */
  readonly allZero: boolean;
}

/**
 * Zero-safe vertical scale for the completed-response trend. The maximum is
 * exactly the measured peak, never a fabricated positive floor, so an
 * all-zero window reports `max: 0` and callers must label it honestly. Gaps
 * are excluded; empty input has no measured values and is not "all zero".
 */
export function trendAxis(points: readonly TrendPoint[]): TrendAxis {
  const values: number[] = [];
  for (const point of points) {
    if (point.gap || point.tps === null) continue;
    if (!Number.isFinite(point.tps) || point.tps < 0) continue;
    values.push(point.tps);
  }
  if (values.length === 0) return { max: 0, mid: null, measured: 0, allZero: false };
  const peak = values.reduce((max, value) => Math.max(max, value), 0);
  if (peak <= 0) return { max: 0, mid: null, measured: values.length, allZero: true };
  return { max: peak, mid: peak / 2, measured: values.length, allZero: false };
}

/** Horizontal position by response order, not wall-clock spacing. */
export function trendPointX(index: number, count: number): number {
  if (!Number.isFinite(index) || !Number.isFinite(count) || count <= 1) return 50;
  const clamped = Math.min(Math.max(index, 0), count - 1);
  return TREND_X_INSET + (clamped / (count - 1)) * (100 - TREND_X_INSET * 2);
}

/** Vertical position in percent; null gaps stay unplottable and a valid zero sits on the baseline. */
export function trendPointY(tps: number | null | undefined, axisMax: number): number | null {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || tps < 0) return null;
  if (!Number.isFinite(axisMax) || axisMax <= 0) return TREND_Y_BOTTOM;
  const clamped = Math.min(tps, axisMax);
  return TREND_Y_BOTTOM - (clamped / axisMax) * (TREND_Y_BOTTOM - TREND_Y_TOP);
}

export interface SimpleSummaryPresentation {
  readonly last: RateParts;
  readonly weighted: RateParts;
  readonly lastLabel: string;
  readonly weightedLabel: string;
  readonly scopeNote: string;
  readonly lastHint: string;
  readonly weightedHint: string;
  readonly explanation: string;
}

/**
 * Concise Simple cards. The latest card uses the shared latest-measurement
 * policy (a newer unmeasured response never borrows an older rate) and the
 * weighted card uses the same paired provider-active arithmetic as Detailed.
 * No wall-clock rate or counter is included in this presentation.
 */
export function simpleSummaryPresentation(
  summary: TpsSummary,
  scopeName: string,
  lang: Language = "en",
): SimpleSummaryPresentation {
  const l = normalizeLanguage(lang);
  const latest = latestMeasurement(summary);
  const lastAvailable = latest.hasLatest && latest.primary !== null;
  const weightedAvailable =
    summary.activeCount > 0 &&
    typeof summary.weightedPrimaryTps === "number" &&
    Number.isFinite(summary.weightedPrimaryTps);
  // Keep the availability flag and displayed value aligned even if a caller
  // hands in a hand-built summary with a finite rate but no measured pair.
  const lastText = lastAvailable ? formatTps(latest.primary, l) : "—";
  const weightedText = weightedAvailable ? formatTps(summary.weightedPrimaryTps, l) : "—";
  return {
    last: splitFormattedRate(lastText, lastAvailable),
    weighted: splitFormattedRate(weightedText, weightedAvailable),
    lastLabel: t(l, "hero.last"),
    weightedLabel: t(l, "hero.weighted"),
    scopeNote: t(l, "hero.scope", { scope: scopeName }),
    lastHint: lastAvailable
      ? t(l, "simple.lastHint", { scope: scopeName })
      : t(l, "simple.lastUnavailable"),
    weightedHint: weightedAvailable
      ? t(l, "simple.weightedHint", { scope: scopeName })
      : t(l, "simple.weightedUnavailable"),
    explanation: t(l, "simple.explanation"),
  };
}

export interface ToolbarStatePresentation {
  /** Null for a healthy connection: no redundant Connected label is rendered. */
  readonly text: string | null;
  readonly tone: "bad" | "warn" | null;
  readonly exceptional: boolean;
}

/** Quiet healthy toolbar; only disconnected/partial states are named. */
export function toolbarStatePresentation(
  connected: boolean,
  partial: boolean,
  lang: Language = "en",
): ToolbarStatePresentation {
  const l = normalizeLanguage(lang);
  if (!connected) {
    return { text: t(l, "toolbar.disconnected"), tone: "bad", exceptional: true };
  }
  if (partial) {
    return { text: t(l, "toolbar.partial"), tone: "warn", exceptional: true };
  }
  return { text: null, tone: null, exceptional: false };
}

export interface ListboxOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly disabled?: boolean;
  /** Natural direction for a native-language label; omitted for ordinary data. */
  readonly dir?: TextDirection;
}

function enabledOptions(options: readonly ListboxOption[]): ListboxOption[] {
  return options.filter((option) => option.disabled !== true);
}

function enabledIndex(options: readonly ListboxOption[], value: string | null): number {
  if (value === null) return -1;
  return enabledOptions(options).findIndex((option) => option.value === value);
}

/**
 * Keep the active option valid when the inventory changes. A still-present
 * active value wins; otherwise the committed selection is preferred, then the
 * first enabled option. Nothing is committed as a side effect.
 */
export function reconcileListboxActive(
  options: readonly ListboxOption[],
  activeValue: string | null,
  selectedValue: string | null,
): string | null {
  const list = enabledOptions(options);
  if (activeValue !== null && list.some((option) => option.value === activeValue)) {
    return activeValue;
  }
  if (selectedValue !== null && list.some((option) => option.value === selectedValue)) {
    return selectedValue;
  }
  return list[0]?.value ?? null;
}

/** Move through enabled options with wrap-around. */
export function moveListboxActive(
  options: readonly ListboxOption[],
  activeValue: string | null,
  delta: number,
): string | null {
  const list = enabledOptions(options);
  if (list.length === 0) return null;
  const idx = enabledIndex(options, activeValue);
  if (idx < 0) return delta >= 0 ? list[0]!.value : list[list.length - 1]!.value;
  const next = (idx + delta + list.length) % list.length;
  return list[next]!.value;
}

export function firstListboxActive(options: readonly ListboxOption[]): string | null {
  return enabledOptions(options)[0]?.value ?? null;
}

export function lastListboxActive(options: readonly ListboxOption[]): string | null {
  const list = enabledOptions(options);
  return list[list.length - 1]?.value ?? null;
}

/** Practical single-character typeahead over visible option labels. */
export function typeaheadListboxActive(
  options: readonly ListboxOption[],
  activeValue: string | null,
  key: string,
): string | null {
  if (key.length !== 1 || key === " ") return null;
  const list = enabledOptions(options);
  if (list.length === 0) return null;
  const needle = key.toLocaleLowerCase();
  const start = enabledIndex(options, activeValue);
  for (let step = 1; step <= list.length; step += 1) {
    const option = list[(start + step + list.length) % list.length]!;
    if (option.label.toLocaleLowerCase().startsWith(needle)) return option.value;
  }
  return null;
}

export interface ListboxKeyboardResult {
  /** True when the key was consumed and default scrolling/activation must be prevented. */
  readonly handled: boolean;
  readonly close: boolean;
  /** Return DOM focus to the trigger (commit, Escape, or Tab dismissal). */
  readonly focusTrigger: boolean;
  readonly activeValue: string | null;
  /** Selected value to commit, or null when the key only moved/dismissed. */
  readonly commitValue: string | null;
}

/**
 * Exhaustive keyboard policy for the selection listbox: arrows wrap,
 * Home/End jump, Enter/Space commit the active enabled option, Escape closes
 * with focus return, and Tab dismisses without trapping focus. Typeahead
 * moves the active option but never commits.
 */
export function listboxKeyboard(
  key: string,
  options: readonly ListboxOption[],
  activeValue: string | null,
): ListboxKeyboardResult {
  const base: ListboxKeyboardResult = {
    handled: false,
    close: false,
    focusTrigger: false,
    activeValue,
    commitValue: null,
  };
  switch (key) {
    case "ArrowDown":
      return { ...base, handled: true, activeValue: moveListboxActive(options, activeValue, 1) };
    case "ArrowUp":
      return { ...base, handled: true, activeValue: moveListboxActive(options, activeValue, -1) };
    case "Home":
      return { ...base, handled: true, activeValue: firstListboxActive(options) };
    case "End":
      return { ...base, handled: true, activeValue: lastListboxActive(options) };
    case "Enter":
    case " ": {
      const active = enabledOptions(options).find((option) => option.value === activeValue);
      if (!active) return { ...base, handled: true };
      return {
        ...base,
        handled: true,
        close: true,
        focusTrigger: true,
        commitValue: active.value,
      };
    }
    case "Escape":
      return { ...base, handled: true, close: true, focusTrigger: true };
    case "Tab":
      // Dismiss, return focus to the trigger, then let the browser move on.
      return { ...base, close: true, focusTrigger: true };
    default: {
      const typed = typeaheadListboxActive(options, activeValue, key);
      return typed === null ? base : { ...base, handled: true, activeValue: typed };
    }
  }
}

/** DOM id for one option, shared by the component and source-level tests. */
export function listboxOptionID(
  baseID: string,
  value: string,
  options: readonly ListboxOption[],
): string | undefined {
  const index = options.findIndex((option) => option.value === value);
  return index < 0 ? undefined : `${baseID}-option-${index}`;
}

export interface ListboxScrollInput {
  readonly optionTop: number;
  readonly optionBottom: number;
  readonly listTop: number;
  readonly listBottom: number;
  readonly scrollTop: number;
  readonly margin?: number;
}

/**
 * Minimal contained scroll adjustment for the active option. It only changes
 * the list's own scrollTop, never the page or panel: an option above the
 * viewport scrolls up, one below scrolls down, and a fully visible option is
 * left alone. A 2px inset keeps focus outlines from sitting on the edge.
 */
export function nextListboxScrollTop(input: ListboxScrollInput): number {
  const margin = input.margin ?? 2;
  const innerTop = input.listTop + margin;
  const innerBottom = input.listBottom - margin;
  if (input.optionTop < innerTop) {
    return Math.max(0, input.scrollTop - (innerTop - input.optionTop));
  }
  if (input.optionBottom > innerBottom) {
    return input.scrollTop + (input.optionBottom - innerBottom);
  }
  return input.scrollTop;
}
