/**
 * Author-defined presentation selectors for the TPSTracer dashboard.
 *
 * Pure, framework-free helpers over `TpsSample` lists: history ordering and
 * windowing, SVG trend points and scope/summary selection. Metric arithmetic
 * stays in metrics.ts; nothing here sums concurrent TPS or fabricates data.
 */

import { agentLabel, formatDuration, formatTokens, formatTps, summarize, type TpsObservation, type TpsSample, type TpsSummary } from "./metrics.js";
import type { DiagnosticReason, Language } from "./definition.js";
import { isolateForLanguage, normalizeLanguage } from "./definition.js";
import { diagnosticText, t } from "./i18n.js";
import type { LiveScopeSnapshot } from "./live.js";

export const HISTORY_INITIAL_ROWS = 10;
export const HISTORY_STEP = 10;
export const TREND_MAX_POINTS = 30;
export const AGENTS_INITIAL_COUNT = 6;
export const AGENTS_STEP = 6;

export interface TrendPoint {
  readonly id: string;
  /** Provider-active rate, or null when the response has no active measurement (honest gap). */
  readonly tps: number | null;
  /** 0..1 fraction of the trend maximum; gaps and all-zero yield 0 (never plotted as zero). */
  readonly ratio: number;
  /** True when the response is unmeasured and must break the line, not bridge it. */
  readonly gap: boolean;
}

/** History sorted newest-first by completion time (ties keep id order). */
export function sortHistoryDesc(samples: readonly TpsSample[]): TpsSample[] {
  return [...samples].sort((a, b) => {
    if (b.completed !== a.completed) return b.completed - a.completed;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Visible history window: at most `visible` rows of the newest-first list. */
export function historyWindow(samples: readonly TpsSample[], visible: number): TpsSample[] {
  if (visible <= 0) return [];
  return sortHistoryDesc(samples).slice(0, visible);
}

/**
 * Last `max` completed samples in chronological order with zero-safe
 * scaling over provider-active rates. Unmeasured responses yield gaps
 * (`tps: null`, `gap: true`): callers must break the line there, never plot
 * unknown as zero nor silently connect across missing measurements.
 * Empty input yields no points; a single measured point yields ratio 0 when
 * the peak is zero, and a single gap yields ratio 0 with gap true.
 */
export function trendPoints(samples: readonly TpsSample[], max: number = TREND_MAX_POINTS): TrendPoint[] {
  if (max <= 0) return [];
  const ordered = [...samples].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed - b.completed;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const windowed = ordered.slice(Math.max(0, ordered.length - max));
  let peak = 0;
  for (const s of windowed) {
    const v = s.primaryTps;
    if (typeof v === "number" && Number.isFinite(v) && v > peak) peak = v;
  }
  return windowed.map((s) => {
    const v = s.primaryTps;
    const measured = typeof v === "number" && Number.isFinite(v) && v >= 0;
    return {
      id: s.id,
      tps: measured ? v : null,
      ratio: measured && peak > 0 ? (v as number) / peak : 0,
      gap: !measured,
    };
  });
}

/** Active coverage of one summary: measured active pairs over completed responses. */
export function activeCoverage(summary: TpsSummary): { readonly measured: number; readonly total: number; readonly partial: boolean } {
  return { measured: summary.activeCount, total: summary.completedCount, partial: summary.activeCount < summary.completedCount };
}

export interface LatestMeasurement {
  /** True when any completed response exists (measured or not). */
  readonly hasLatest: boolean;
  /** True when the latest completed response is unmeasured (rates unavailable). */
  readonly unmeasured: boolean;
  /** Latest primary rate, or null when unmeasured/none. Never an older rate. */
  readonly primary: number | null;
  /** Latest wall rate, or null when unmeasured/none. Never an older rate. */
  readonly wall: number | null;
  /** Latest completed model label, even when unmeasured. Null when none. */
  readonly model: string | null;
}

/**
 * Single latest-measurement policy for header, heroes and delegate cards.
 * The latest completed successful observation wins even when unmeasured:
 * rates stay unavailable and the model comes from the observation, never
 * borrowed from an older measured sample.
 */
export function latestMeasurement(summary: TpsSummary): LatestMeasurement {
  const last = summary.last;
  const completed = summary.lastCompleted;
  if (completed && (!last || completed.id !== last.id)) {
    return { hasLatest: true, unmeasured: true, primary: null, wall: null, model: completed.model };
  }
  if (last) {
    return { hasLatest: true, unmeasured: false, primary: last.primaryTps, wall: last.wallTps, model: last.model };
  }
  return { hasLatest: false, unmeasured: false, primary: null, wall: null, model: null };
}

/**
 * Split trend points into contiguous measured runs. Gaps break the line:
 * each returned segment contains only measured points. Singletons are
 * isolated dots (callers must render a dot, not an invisible zero-length
 * polyline and not a bridge across the gap).
 */
export function splitTrendSegments(points: readonly TrendPoint[]): TrendPoint[][] {
  const segs: TrendPoint[][] = [];
  let cur: TrendPoint[] = [];
  const flush = () => {
    if (cur.length > 0) segs.push(cur);
    cur = [];
  };
  for (const p of points) {
    if (p.gap || p.tps === null) {
      flush();
      continue;
    }
    cur.push(p);
  }
  flush();
  return segs;
}

/** Progressive model disclosure keeper: preserve count on same root, reset on root change. */
export function nextModelsVisibleState(
  prev: { readonly root: string; readonly visible: number },
  nextRoot: string,
  initial: number,
): { readonly root: string; readonly visible: number } {
  if (prev.root === nextRoot) return prev;
  return { root: nextRoot, visible: initial };
}

/**
 * Reserved model status line (always mounted, fixed single-line geometry).
 * Partial detail lives in the toolbar disclosure; this line shows only
 * short states so partial↔loading swaps never insert/remove banners.
 */
export function modelStatusNote(
  inv: { readonly entries: readonly unknown[]; readonly loading: boolean; readonly disconnected: boolean; readonly totalMeasuredActive: number; readonly totalObserved: number },
  lang: Language = "en",
): string {
  const l = normalizeLanguage(lang);
  if (inv.disconnected) return t(l, "subagents.disconnectedDetail");
  if (inv.entries.length === 0 && inv.loading) return t(l, "models.loading");
  if (inv.entries.length === 0) return t(l, "models.empty");
  return t(l, "models.measured", {
    measured: isolateForLanguage(formatTokens(inv.totalMeasuredActive, l), "ltr", l),
    observed: isolateForLanguage(formatTokens(inv.totalObserved, l), "ltr", l),
  });
}

export type ScopeKind = "session" | "agent";

export interface DashboardScope {
  readonly kind: ScopeKind;
  /** Session id for `session`, agent name (or null for unknown) for `agent`. */
  readonly key: string | null;
  readonly label: string;
}

/** Summarize exactly one scope's own samples; never a cross-scope total. */
export function scopeSummary(samples: readonly TpsSample[], observations?: readonly TpsObservation[]): TpsSummary {
  return summarize(samples, observations);
}

/**
 * Samples for one dashboard scope: the whole session list, or only the
 * samples of one retained agent (`agentKey === null` selects unknown).
 */
export function samplesForScope(
  samples: readonly TpsSample[],
  scope: DashboardScope,
): readonly TpsSample[] {
  if (scope.kind === "session") return samples;
  return samples.filter((s) => s.agent === scope.key);
}

/** Shorten a long model id visually; the full value stays in `title`. */
export function shortModel(model: string, max = 28): string {
  if (model.length <= max) return model;
  if (max <= 1) return "…";
  return `${model.slice(0, max - 1)}…`;
}

/** Compact window over any list (agent cards, rows): first `count` items. */
export function limitList<T>(list: readonly T[], count: number): readonly T[] {
  if (count <= 0) return [];
  return list.slice(0, count);
}

/**
 * Agent filter selection. A discriminated union — never a bare `"all"`
 * string — so a real agent literally named `all` still filters correctly.
 */
export type AgentSelection = { readonly kind: "all" } | { readonly kind: "agent"; readonly agent: string | null };

export const ALL_AGENTS: AgentSelection = { kind: "all" };

export function agentSelectionOf(agent: string | null): AgentSelection {
  return { kind: "agent", agent };
}

/** Whether one sample's retained agent belongs to the selection. */
export function agentMatches(sampleAgent: string | null, selection: AgentSelection): boolean {
  if (selection.kind === "all") return true;
  return sampleAgent === selection.agent;
}

/** Samples of one agent selection within a scope. */
export function samplesForAgentSelection(
  samples: readonly TpsSample[],
  selection: AgentSelection,
): readonly TpsSample[] {
  if (selection.kind === "all") return samples;
  return samples.filter((s) => s.agent === selection.agent);
}

/** Observations of one agent selection within a scope (same rule as samples). */
export function observationsForAgentSelection(
  observations: readonly TpsObservation[],
  selection: AgentSelection,
): readonly TpsObservation[] {
  if (selection.kind === "all") return observations;
  return observations.filter((o) => o.agent === selection.agent);
}

/**
 * Reset an agent selection when its agent no longer exists (new root or a
 * vanished scope): unknown selections fall back to all agents.
 */
export function normalizeAgentSelection(
  agents: readonly (string | null)[],
  selection: AgentSelection,
): AgentSelection {
  if (selection.kind === "all") return selection;
  return agents.some((a) => a === selection.agent) ? selection : ALL_AGENTS;
}

export function agentSelectionLabel(selection: AgentSelection, lang: Language = "en"): string {
  if (selection.kind === "all") return t(normalizeLanguage(lang), "agent.all");
  return agentLabel(selection.agent, lang);
}

/** Whether the selection currently highlights one agent group. */
export function isAgentSelected(selection: AgentSelection, agent: string | null): boolean {
  return selection.kind === "agent" && selection.agent === agent;
}

export interface ScopeOption {
  readonly sessionID: string;
  readonly label: string;
  readonly detail: string;
}

export interface ScopeTreeLike {
  readonly rootSessionID: string;
  readonly children: readonly {
    readonly sessionID: string;
    readonly title: string | null;
    readonly agent: string | null;
    readonly depth: number;
  }[];
}

export function rootScopeLabel(childCount: number, lang: Language = "en"): string {
  void childCount;
  const l = normalizeLanguage(lang);
  return t(l, "scope.current");
}

function childScopeName(
  child: { title: string | null; agent: string | null },
  lang: Language = "en",
): string {
  const l = normalizeLanguage(lang);
  if (child.title) return isolateForLanguage(`«${child.title}»`, "auto", l);
  const label = agentLabel(child.agent, l);
  return t(l, "scope.childName", {
    agent: child.agent === null ? label : isolateForLanguage(label, "auto", l),
  });
}

/** Human scope name for hero/trend/history labels (never invents titles). Defaults to English. */
export function scopeDisplayName(tree: ScopeTreeLike, sessionID: string, lang: Language = "en"): string {
  const l = normalizeLanguage(lang);
  if (sessionID === tree.rootSessionID) {
    return t(l, "scope.thisSession");
  }
  const child = tree.children.find((c) => c.sessionID === sessionID);
  if (!child) return t(l, "scope.thisSession");
  return childScopeName(child, l);
}

/**
 * Header provenance for the followed delegate: each raw title/agent is
 * isolated independently in Arabic, so mixed scripts cannot bleed into the
 * authored wrapper. Non-Arabic output is unchanged; raw identity stays data.
 */
export function headerProvenance(
  identity:
    | { readonly title: string | null; readonly agent: string | null; readonly isDelegate: boolean }
    | undefined,
  lang: Language = "en",
): string {
  const l = normalizeLanguage(lang);
  if (!identity || !identity.isDelegate) return rootScopeLabel(0, l);
  const title = typeof identity.title === "string" && identity.title.length > 0 ? identity.title : null;
  const agent = typeof identity.agent === "string" && identity.agent.length > 0 ? identity.agent : null;
  const titleText = title === null ? null : isolateForLanguage(`«${title}»`, "auto", l);
  const agentText = agent === null ? null : isolateForLanguage(agent, "auto", l);
  if (titleText !== null && agentText !== null) return `${titleText} · ${agentText}`;
  if (titleText !== null) return titleText;
  if (agentText !== null) return agentText;
  return agentLabel(null, l);
}

/** Flat session options for the scope selection popover, root first. Defaults to English. */
export function scopeOptionsFor(tree: ScopeTreeLike, lang: Language = "en"): ScopeOption[] {
  const l = normalizeLanguage(lang);
  const options: ScopeOption[] = [
    {
      sessionID: tree.rootSessionID,
      label: rootScopeLabel(tree.children.length, l),
      detail: t(l, "scope.selected"),
    },
  ];
  for (const c of tree.children) {
    options.push({
      sessionID: c.sessionID,
      label: c.title ?? agentLabel(c.agent, l),
      detail: t(l, "scope.child", {
        depth: isolateForLanguage(formatTokens(c.depth, l), "ltr", l),
      }),
    });
  }
  return options;
}

/** Whether a session id is a selectable scope of the current tree. */
export function isKnownScope(tree: ScopeTreeLike, sessionID: string): boolean {
  return sessionID === tree.rootSessionID || tree.children.some((c) => c.sessionID === sessionID);
}

/**
 * Minimal render input for the refresh-stability policy: scope status,
 * retained samples, and completed-observation coverage. Structural typing
 * keeps this helper free of adapter/tree imports while staying honest about
 * empty vs stale scopes. A scope with completed observations but no
 * wall-valid samples still has content (unavailable rates + coverage),
 * while genuinely empty scopes (no completed at all) keep honest states.
 */
export interface ScopeRenderSnapshot {
  readonly status: string;
  readonly samples: readonly unknown[];
  readonly summary?: { readonly completedCount?: number } | null;
}

export interface ScopeRenderPolicy {
  /** Keep the scope content mounted (ready/partial, or refresh with data). */
  readonly showContent: boolean;
  /** Designed initial-loading state in the stable region (no data yet). */
  readonly showLoading: boolean;
  /** Background update with prior data: toolbar spinner only, no in-flow row. */
  readonly refreshing: boolean;
}

function completedOf(snap: ScopeRenderSnapshot): number {
  return snap.summary?.completedCount ?? 0;
}

/**
 * Whether a scope keeps its mounted content: `ready`/`partial`, or
 * `loading`/`idle` while retaining prior samples or completed observations
 * of the same scope. Error, empty and disconnected scopes (cleared data)
 * never keep content, so their honest states stay visible instead of
 * masquerading as data.
 */
export function hasScopeContent(snap: ScopeRenderSnapshot): boolean {
  if (snap.status === "ready" || snap.status === "partial") return true;
  return (
    (snap.status === "loading" || snap.status === "idle") &&
    (snap.samples.length > 0 || completedOf(snap) > 0)
  );
}

/**
 * Stable refresh policy for one selected scope. A `loading` tree or a
 * `loading`/`idle` snapshot with retained samples or completed observations
 * keeps content mounted and signals through the toolbar spinner only — no
 * in-flow loading card or updating line is inserted between the scope
 * selector and the hero. Scopes without data show the designed loading
 * state; error/empty/disconnected keep their own honest blocks.
 */
export function scopeRenderPolicy(treeStatus: string, snap: ScopeRenderSnapshot): ScopeRenderPolicy {
  const showContent = hasScopeContent(snap);
  const showLoading =
    (snap.status === "loading" || snap.status === "idle") &&
    snap.samples.length === 0 &&
    completedOf(snap) === 0;
  const refreshing =
    showContent &&
    (snap.status === "loading" || snap.status === "idle" || treeStatus === "loading");
  return { showContent, showLoading, refreshing };
}

/**
 * Sticky partial detail across background refreshes. Adapter/tree snapshots
 * clear their partial reason while `loading`, which would flicker any
 * partial notice off and on around the hero on every refresh. The view keeps
 * the last honest note per scope key and only refreshes it from live data
 * when not mid-refresh; a scope change always takes the new scope's live
 * value, never another scope's note as its own.
 */
export interface PartialNoteState {
  readonly key: string;
  readonly note: string | null;
}

export function nextPartialNote(
  state: PartialNoteState,
  key: string,
  live: string | null,
  refreshing: boolean,
): PartialNoteState {
  if (key !== state.key) return { key, note: live };
  if (refreshing) return state;
  return { key, note: live };
}

/**
 * Sticky first-party reason data across refreshes. Unlike `PartialNoteState`
 * (kept for compatibility), this stores reason codes plus an optional
 * verbatim third-party detail — never a translated copy — so the view can
 * retranslate already loaded data immediately after a language change.
 */
export interface PartialReasonState {
  readonly key: string;
  readonly reason: DiagnosticReason | null;
  readonly verbatim: string | null;
}

export function nextPartialReason(
  state: PartialReasonState,
  key: string,
  liveReason: DiagnosticReason | null,
  liveVerbatim: string | null,
  refreshing: boolean,
): PartialReasonState {
  if (key !== state.key) return { key, reason: liveReason, verbatim: liveVerbatim };
  if (refreshing) return state;
  return { key, reason: liveReason, verbatim: liveVerbatim };
}

export interface ResolvedScope {
  /** Effective selection: falls back to the root when the id vanished. */
  readonly sessionID: string;
  readonly known: boolean;
  readonly label: string;
}

/**
 * Resolve the dashboard selection against the live tree. The view renders
 * navigation from this (never gated on data), so picking an empty, loading
 * or failed scope can never trap the user without a way back.
 * Defaults to English labels.
 */
export function resolveScope(tree: ScopeTreeLike, selectedID: string, lang: Language = "en"): ResolvedScope {
  const l = normalizeLanguage(lang);
  if (isKnownScope(tree, selectedID)) {
    return { sessionID: selectedID, known: true, label: scopeDisplayName(tree, selectedID, l) };
  }
  return { sessionID: tree.rootSessionID, known: false, label: scopeDisplayName(tree, tree.rootSessionID, l) };
}

/** Locale-aware TTFT: integer milliseconds under one second, seconds above. */
export function formatTtft(ttftMs: number | null | undefined, lang: Language = "en"): string {
  if (ttftMs === null || ttftMs === undefined || !Number.isFinite(ttftMs) || ttftMs < 0) return "—";
  if (ttftMs < 1000) return `${formatTokens(Math.round(ttftMs), lang)} ms`;
  return formatDuration(ttftMs, lang);
}

/** Exact-scope lookup; never borrows another session's live state. */
export function liveSnapshotFor(
  live: readonly LiveScopeSnapshot[] | undefined,
  sessionID: string,
): LiveScopeSnapshot | null {
  if (!live || live.length === 0) return null;
  return live.find((entry) => entry.sessionID === sessionID) ?? null;
}

/** Localized live lifecycle label; short form is used in the compact header. */
export function liveActivityLabel(
  live: Pick<LiveScopeSnapshot, "phase" | "activeTools"> | null | undefined,
  lang: Language = "en",
  short = false,
): string {
  const l = normalizeLanguage(lang);
  if (!live) return t(l, "live.idle");
  switch (live.phase) {
    case "waiting":
      return t(l, short ? "live.shortWaiting" : "live.waiting");
    case "streaming":
      return t(l, short ? "live.shortStreaming" : "live.streaming");
    case "tool":
      return live.activeTools === 1
        ? t(l, short ? "live.shortTool" : "live.tool")
        : t(l, short ? "live.shortTools" : "live.tools", {
            count: isolateForLanguage(formatTokens(live.activeTools, l), "ltr", l),
          });
    case "retry":
      return t(l, short ? "live.shortRetry" : "live.retry");
    case "settling":
      return t(l, short ? "live.shortSettling" : "live.settling");
    case "idle":
    default:
      return t(l, "live.idle");
  }
}

export interface LiveRowPresentation {
  readonly activity: string;
  readonly detail: string;
  readonly estimate: string;
  readonly ttft: string;
  /** True only when `estimate` carries a visible approximate numeric rate. */
  readonly approximate: boolean;
  readonly estimateEnabled: boolean;
}

/**
 * Pure live/TTFT row selector for the dashboard. The estimate is suppressed
 * (never replaced by a final or wall rate) while disabled, waiting, using
 * tools, retrying or settling. TTFT and activity remain available.
 */
export function liveRowPresentation(
  live: LiveScopeSnapshot | null | undefined,
  lang: Language = "en",
  estimateEnabled = true,
  finalRate: string | null = null,
): LiveRowPresentation {
  const l = normalizeLanguage(lang);
  const enabled = estimateEnabled !== false;
  if (!live) {
    return {
      activity: t(l, "live.idle"),
      detail: finalRate !== null ? t(l, "live.finalContext", {
        rate: isolateForLanguage(finalRate, "ltr", l),
      }) : "",
      estimate: enabled ? "—" : t(l, "live.estimateOff"),
      ttft: "—",
      approximate: false,
      estimateEnabled: enabled,
    };
  }
  const activity = liveActivityLabel(live, l);
  const details: string[] = [];
  if (live.elapsedMs !== null) {
    details.push(
      t(l, "live.elapsed", {
        duration: isolateForLanguage(formatDuration(live.elapsedMs, l), "ltr", l),
      }),
    );
  } else if (live.active) {
    details.push(t(l, "live.elapsedUnknown"));
  }
  if (finalRate !== null) {
    details.push(
      t(l, "live.finalContext", {
        rate: isolateForLanguage(finalRate, "ltr", l),
      }),
    );
  }
  const numeric = enabled && live.phase === "streaming" && live.estimatedTps !== null;
  const estimate = !enabled
    ? t(l, "live.estimateOff")
    : numeric
      ? isolateForLanguage(`~${formatTps(live.estimatedTps, l)}`, "ltr", l)
      : "—";
  const ttft = live.ttftMs !== null
    ? t(l, "live.ttftObserved", {
        duration: isolateForLanguage(formatTtft(live.ttftMs, l), "ltr", l),
      })
    : t(l, "live.ttftUnknown");
  return {
    activity,
    detail: details.join(" · "),
    estimate,
    ttft,
    approximate: numeric,
    estimateEnabled: enabled,
  };
}

/** Latest final primary rate text for exactly this summary; null when unavailable. */
export function sessionFinalRate(summary: TpsSummary, lang: Language = "en"): string | null {
  const latest = latestMeasurement(summary);
  return latest.hasLatest && latest.primary !== null ? formatTps(latest.primary, lang) : null;
}

/** Minimal header input: status plus retained summary/error data. No live generation signal. */
export interface HeaderBadgeSnapshot {
  readonly status: string;
  readonly summary: TpsSummary;
  readonly error?: string | null;
  readonly reason?: DiagnosticReason | null;
}

export interface HeaderBadgePresentation {
  /** Compact badge text: measured rate without a provenance prefix, explicit `~` live estimate, `TPS …` only when loading without data, else `TPS —`/`—`. */
  readonly text: string;
  /** Localized tooltip/aria label: latest completed measurement or explicit live/TTFT context, never a hidden claim. */
  readonly label: string;
  /** True during background refresh (loading, or idle with retained data). Drives `aria-busy` only. */
  readonly refreshing: boolean;
  /** Visible observed TTFT, when available; null/undefined otherwise. */
  readonly ttft?: string | null;
  /** Visible short activity label for waiting/tool/retry/settling; null when not needed. */
  readonly activity?: string | null;
  /** True only while the text is an explicitly approximate live estimate. */
  readonly live?: boolean;
}

function headerReasonText(
  reason: DiagnosticReason | null | undefined,
  verbatim: string | null | undefined,
  lang: Language,
  fallback: DiagnosticReason,
): string {
  const l = normalizeLanguage(lang);
  if (reason) return diagnosticText(reason, l);
  if (verbatim !== null && verbatim !== undefined) return isolateForLanguage(verbatim, "auto", l);
  return diagnosticText(fallback, l);
}

/**
 * Pure header presentation selector used by `HeaderBadge`.
 *
 * `loading`/`idle` with a retained latest measurement keeps showing that
 * explicitly historic value (same primary as `ready`, or unavailable when
 * the latest completed response is unmeasured) with `refreshing: true` and
 * a "latest completed … updating" label. `TPS …` is reserved for `loading`
 * without any completed data; `idle` without data stays unavailable.
 * `error`/`disconnected` never surface retained data as current, `partial`
 * keeps its `~` qualifier, and no wall/weighted rate is ever shown as the
 * latest primary.
 */
export function headerBadgePresentation(
  snap: HeaderBadgeSnapshot,
  connected: boolean,
  lang: Language = "en",
  live?: LiveScopeSnapshot | null,
  estimateEnabled = true,
): HeaderBadgePresentation {
  const l = normalizeLanguage(lang);
  const ltr = (value: string): string => isolateForLanguage(value, "ltr", l);
  if (!connected || snap.status === "disconnected") {
    return { text: "TPS —", label: t(l, "status.disconnected"), refreshing: false };
  }
  if (snap.status === "error") {
    return {
      text: "TPS —",
      label: t(l, "status.error", {
        reason: headerReasonText(snap.reason, snap.error, l, { kind: "unknown-error" }),
      }),
      refreshing: false,
    };
  }
  if (live && !live.active) {
    const base = headerBadgePresentation(snap, connected, l, undefined, estimateEnabled);
    if (live.ttftMs !== null) {
      const ttft = t(l, "header.ttftShort", { duration: formatTtft(live.ttftMs, l) });
      return { ...base, ttft, label: `${base.label} · ${ltr(ttft)}` };
    }
    return { ...base, ttft: null };
  }
  if (live && live.active) {
    const enabled = estimateEnabled !== false;
    const activity = liveActivityLabel(live, l, true);
    const ttft = live.ttftMs !== null ? t(l, "header.ttftShort", { duration: formatTtft(live.ttftMs, l) }) : null;
    const latest = latestMeasurement(snap.summary);
    const formattedPrimary = latest.hasLatest && latest.primary !== null ? formatTps(latest.primary, l) : "—";
    if (live.phase === "streaming" && enabled && live.estimatedTps !== null) {
      const rate = `~${formatTps(live.estimatedTps, l)}`;
      const parts = [t(l, "header.liveEstimate", { rate: ltr(rate) }), ttft === null ? null : ltr(ttft)];
      return {
        text: rate,
        label: parts.filter((part): part is string => part !== null).join(" · "),
        refreshing: true,
        ttft,
        activity: null,
        live: true,
      };
    }
    const contextParts: string[] = [];
    if (latest.hasLatest) contextParts.push(t(l, "header.finalContext", { rate: ltr(formattedPrimary) }));
    if (!enabled) contextParts.push(t(l, "live.estimateOff"));
    contextParts.push(activity);
    if (ttft !== null) contextParts.push(ltr(ttft));
    return {
      text: latest.hasLatest ? formattedPrimary : "TPS …",
      label: contextParts.join(" · "),
      refreshing: true,
      ttft,
      activity,
      live: false,
    };
  }
  const latest = latestMeasurement(snap.summary);
  // Formatted once per invocation, only when a latest measurement exists:
  // empty states fall back to the literal without paying for a formatter,
  // and error/disconnected already returned above. No cross-scope/locale
  // cache: Intl maps stay in metrics.
  const formattedPrimary: string = latest.hasLatest ? formatTps(latest.primary, l) : "—";
  if (snap.status === "ready") {
    if (!latest.hasLatest) return { text: "TPS —", label: "—", refreshing: false };
    const formattedWeighted = formatTps(snap.summary.weightedPrimaryTps, l);
    return {
      text: formattedPrimary,
      label: t(l, "status.readySession", {
        last: ltr(formattedPrimary),
        weighted: ltr(formattedWeighted),
      }),
      refreshing: false,
    };
  }
  if (snap.status === "partial") {
    if (latest.hasLatest) {
      return {
        text: `${formattedPrimary}~`,
        label: t(l, "status.partial", {
          reason: headerReasonText(snap.reason, snap.error, l, { kind: "session-incomplete" }),
        }),
        refreshing: false,
      };
    }
    return {
      text: "TPS —",
      label: t(l, "status.partial", {
        reason: headerReasonText(snap.reason, snap.error, l, { kind: "session-incomplete" }),
      }),
      refreshing: false,
    };
  }
  if (snap.status === "loading" || snap.status === "idle") {
    if (latest.hasLatest) {
      if (latest.primary !== null) {
        return {
          text: formattedPrimary,
          label: t(l, "header.latestRefreshing", { rate: ltr(formattedPrimary) }),
          refreshing: true,
        };
      }
      return { text: "TPS —", label: t(l, "header.latestUnmeasuredRefreshing"), refreshing: true };
    }
    if (snap.status === "loading") {
      return { text: "TPS …", label: t(l, "status.loading"), refreshing: true };
    }
    return { text: "TPS —", label: t(l, "status.idle"), refreshing: false };
  }
  if (snap.status === "empty") {
    return { text: "TPS —", label: t(l, "status.empty"), refreshing: false };
  }
  return { text: "TPS —", label: t(l, "status.idle"), refreshing: false };
}
