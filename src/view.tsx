/**
 * Presentational Solid views for TPSTracer.
 *
 * Props-driven and host-free: English is the default copy regardless of
 * host locale, and every supported language is opt-in through a persisted
 * `lang` prop. Every
 * rate is labelled with exactly the scope it belongs to, and concurrent
 * scopes are never summed. Styling comes from the owned `panel.css`
 * (`tps-` prefix); the light/dark palette follows the host
 * `appearance.mode()` passed in as the `mode` prop. History starts at ten
 * newest rows with progressive expansion; long model ids shorten visually
 * with the full value in `title`. Simple is the default entry view; the
 * Detailed subtree stays mounted but hidden so scope/agent/history and
 * native details expansion survive mode switches. Changing `lang` or the
 * view mode never reloads metrics: controllers live outside these views.
 * First-party reasons are stored as codes and retranslated at presentation
 * time.
 */

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import {
  agentLabel,
  formatDuration,
  formatTokens,
  formatTps,
  type TpsSample,
  type TpsSummary,
} from "./metrics.js";
import type { AdapterSnapshot } from "./adapter.js";
import type { TreeSnapshot } from "./orchestrator.js";
import {
  AGENTS_INITIAL_COUNT,
  AGENTS_STEP,
  agentSelectionLabel,
  agentSelectionOf,
  ALL_AGENTS,
  hasScopeContent,
  headerBadgePresentation,
  headerProvenance,
  HISTORY_INITIAL_ROWS,
  HISTORY_STEP,
  historyWindow,
  isAgentSelected,
  isKnownScope,
  latestMeasurement,
  limitList,
  liveRowPresentation,
  liveSnapshotFor,
  modelStatusNote,
  nextModelsVisibleState,
  nextPartialReason,
  normalizeAgentSelection,
  observationsForAgentSelection,
  resolveScope,
  rootScopeLabel,
  samplesForAgentSelection,
  scopeOptionsFor,
  scopeRenderPolicy,
  sessionFinalRate,
  shortModel,
  splitTrendSegments,
  TREND_MAX_POINTS,
  trendPoints,
  type AgentSelection,
  type PartialReasonState,
  type TrendPoint,
} from "./presentation.js";
import type { LiveScopeSnapshot } from "./live.js";
import { groupByAgent, summarize } from "./metrics.js";
import { inventoryFromTree, MODELS_INITIAL_COUNT, MODELS_STEP, sessionScopeKey } from "./models.js";
import type { DiagnosticReason, Language, ViewMode } from "./definition.js";
import { isolateForLanguage, languageDirection, normalizeLanguage } from "./definition.js";
import { diagnosticText, LANGUAGE_OPTIONS, t, trendSummary } from "./i18n.js";
import {
  dashboardViewPolicy,
  simpleSummaryPresentation,
  splitFormattedRate,
  toolbarStatePresentation,
  trendAxis,
  trendPointX,
  trendPointY,
  TREND_Y_BOTTOM,
  TREND_Y_TOP,
} from "./dashboard.js";
import { LiveEstimateSwitch, SelectionPopover, ViewModeControl } from "./controls.js";

function langOf(lang: Language | undefined): Language {
  return normalizeLanguage(lang);
}

/** Technical numeric fragment kept LTR inside an RTL surface. */
function Ltr(props: { value: string }) {
  return <bdi dir="ltr">{props.value}</bdi>;
}

/**
 * Atomic rate value+unit fragment. The whole pair shares one LTR isolate so
 * RTL layout cannot reorder the numeric value and its unit; unit styling and
 * the logical margin remain intact.
 */
function RateValue(props: { value: string; unit: string }) {
  return (
    <bdi class="tps-rate" dir="ltr">
      <span class="tps-rate-value">{props.value}</span>
      <Show when={props.unit}>
        <span class="tps-unit">{props.unit}</span>
      </Show>
    </bdi>
  );
}

/** Verbatim user/external name isolated with its natural direction. */
function Natural(props: { value: string }) {
  return <bdi dir="auto">{props.value}</bdi>;
}

/** Isolate a technical rate/count/duration fragment inside a translated sentence. */
function ltrText(value: string, lang: Language): string {
  return isolateForLanguage(value, "ltr", lang);
}

/** Localized agent label with raw mixed-script agent names isolated in Arabic. */
function agentText(agent: string | null, lang: Language): string {
  const label = agentLabel(agent, lang);
  return agent === null ? label : isolateForLanguage(label, "auto", lang);
}

/** Verbatim third-party detail stays verbatim; first-party codes translate. */
function reasonDisplay(
  reason: DiagnosticReason | null | undefined,
  verbatim: string | null | undefined,
  lang: Language,
  fallback: DiagnosticReason,
): string {
  const l = langOf(lang);
  if (reason) return diagnosticText(reason, l);
  if (verbatim !== null && verbatim !== undefined) return isolateForLanguage(verbatim, "auto", l);
  return diagnosticText(fallback, l);
}

function snapshotPartialText(snap: AdapterSnapshot, lang: Language): string {
  return reasonDisplay(snap.reason ?? null, snap.error, lang, { kind: "session-incomplete" });
}

function snapshotErrorText(snap: AdapterSnapshot, lang: Language): string {
  return reasonDisplay(snap.reason ?? null, snap.error, lang, { kind: "unknown-error" });
}

export function statusLabel(snap: AdapterSnapshot, lang: Language = "en"): string {
  const l = langOf(lang);
  switch (snap.status) {
    case "loading":
      return t(l, "status.loading");
    case "empty":
      return t(l, "status.empty");
    case "partial":
      return t(l, "status.partial", { reason: snapshotPartialText(snap, l) });
    case "error":
      return t(l, "status.error", { reason: snapshotErrorText(snap, l) });
    case "disconnected":
      return t(l, "status.disconnected");
    case "ready": {
      const latest = latestMeasurement(snap.summary);
      return latest.hasLatest
        ? t(l, "status.readySession", {
            last: ltrText(formatTps(latest.primary, l), l),
            weighted: ltrText(formatTps(snap.summary.weightedPrimaryTps, l), l),
          })
        : "—";
    }
    case "idle":
    default:
      return t(l, "status.idle");
  }
}

/** Compact header indicator. Follows the most recently active verified delegate when one is working (showing its own latest completed primary measurement and compact identity), otherwise the neutral current session. Background refresh keeps the last completed measurement explicitly historic; no live rate is fabricated, no concurrent rates are summed, and busy means working (tools/retry included), never a provider-stream phase claim. An incomplete follow inventory (partial discovery or unavailable scopes) is disclosed in the tooltip/aria copy only, never as a banner and never by attributing another scope's rate. */
export function HeaderBadge(props: {
  snap: AdapterSnapshot;
  connected: boolean;
  onOpen: () => void;
  lang?: Language;
  live?: LiveScopeSnapshot | null;
  estimateEnabled?: boolean;
  identity?: { sessionID: string; title: string | null; agent: string | null; isDelegate: boolean };
  follow?: { partial: boolean; reason?: DiagnosticReason | null; verbatim?: string | null };
}) {
  const l = () => langOf(props.lang);
  const presentation = () => headerBadgePresentation(props.snap, props.connected, l(), props.live, props.estimateEnabled);
  const text = () => presentation().text;
  const liveBadge = () => presentation().live === true;
  const activity = () => presentation().activity ?? null;
  const ttft = () => presentation().ttft ?? null;
  const isDelegate = () => props.identity?.isDelegate === true;
  const identityText = (): string | null => {
    if (!isDelegate()) return null;
    const title = props.identity?.title;
    if (typeof title === "string" && title.length > 0) return title;
    return agentLabel(props.identity?.agent ?? null, l());
  };
  const provenance = (): string => headerProvenance(props.identity, l());
  const head = (): string => {
    if (!isDelegate()) return provenance();
    return t(l(), "header.workingDelegate", { identity: provenance() });
  };
  const partialSuffix = (): string | null => {
    const follow = props.follow;
    if (!follow || follow.partial !== true) return null;
    const reason = follow.reason
      ? diagnosticText(follow.reason, l())
      : typeof follow.verbatim === "string" && follow.verbatim.length > 0
        ? isolateForLanguage(follow.verbatim, "auto", l())
        : diagnosticText({ kind: "subagent-unavailable" }, l());
    return t(l(), "header.partialNote", { reason });
  };
  const label = () => {
    const suffix = partialSuffix();
    return suffix === null ? `${head()} · ${presentation().label}` : `${head()} · ${presentation().label} · ${suffix}`;
  };
  return (
    <button
      type="button"
      class="tps-header-badge"
      lang={l()}
      dir={languageDirection(l())}
      onClick={props.onOpen}
      title={label()}
      aria-label={`TPSTracer: ${label()}. ${t(l(), "header.openHint")}`}
      aria-busy={presentation().refreshing}
    >
      <span aria-hidden="true">⚡</span>
      <span>
        <Ltr value={text()} />
      </span>
      <Show when={liveBadge()}>
        <span class="tps-header-live">
          <Natural value={t(l(), "live.short")} />
        </span>
      </Show>
      <Show when={activity()}>
        <span class="tps-header-activity">
          <Natural value={activity()!} />
        </span>
      </Show>
      <Show when={ttft()}>
        <span class="tps-header-ttft">
          <Ltr value={ttft()!} />
        </span>
      </Show>
      <Show when={isDelegate()}>
        <span class="tps-header-identity" aria-hidden="true">
          <Natural value={identityText() ?? ""} />
        </span>
      </Show>
    </button>
  );
}

function HeroCards(props: {
  summary: TpsSummary;
  scopeName: string;
  lang?: Language;
}) {
  const l = () => langOf(props.lang);
  const latest = () => latestMeasurement(props.summary);
  const lastPrimary = () => splitFormattedRate(formatTps(latest().primary, l()));
  const avgPrimary = () => splitFormattedRate(formatTps(props.summary.weightedPrimaryTps, l()));
  const lastWall = () => ltrText(formatTps(latest().wall, l()), l());
  const avgWall = () => ltrText(formatTps(props.summary.weightedTps, l()), l());
  const coverage = () => t(l(), "hero.coverage", {
    measured: ltrText(formatTokens(props.summary.activeCount, l()), l()),
    total: ltrText(formatTokens(props.summary.completedCount, l()), l()),
  });
  return (
    <div class="tps-hero">
      <div class="tps-card tps-card-main">
        <h3>{t(l(), "hero.last")}</h3>
        <p class="tps-value">
          <RateValue value={lastPrimary().value} unit={lastPrimary().unit} />
        </p>
        <p class="tps-scope">{t(l(), "hero.scope", { scope: props.scopeName })} · {t(l(), "rate.primary")}</p>
        <p class="tps-scope">{t(l(), "hero.secondary", { rate: lastWall() })}</p>
      </div>
      <div class="tps-card tps-card-main">
        <h3>{t(l(), "hero.weighted")}</h3>
        <p class="tps-value">
          <RateValue value={avgPrimary().value} unit={avgPrimary().unit} />
        </p>
        <p class="tps-scope">{t(l(), "hero.scope", { scope: props.scopeName })} · {t(l(), "rate.primary")}</p>
        <p class="tps-scope">{t(l(), "hero.secondary", { rate: avgWall() })}</p>
        <p class="tps-scope">{coverage()}</p>
      </div>
    </div>
  );
}

/**
 * Concise entry view: scope, two final provider-active rates and short
 * explanations. It intentionally omits wall-clock rates, counters, history,
 * trend, model inventory and deep subagent cards; those stay mounted in the
 * hidden Detailed subtree so their expansion state survives mode switches.
 */
function SimpleSummary(props: {
  summary: TpsSummary;
  scopeName: string;
  lang?: Language;
}) {
  const l = () => langOf(props.lang);
  const view = () => simpleSummaryPresentation(props.summary, props.scopeName, l());
  return (
    <section class="tps-simple" aria-label={t(l(), "simple.aria")}>
      <div class="tps-hero tps-hero-simple">
        <div class="tps-card tps-card-main">
          <h3>{view().lastLabel}</h3>
          <p class="tps-value">
            <RateValue value={view().last.value} unit={view().last.unit} />
          </p>
          <p class="tps-scope">{view().scopeNote}</p>
          <p class="tps-simple-note">{view().lastHint}</p>
        </div>
        <div class="tps-card tps-card-main">
          <h3>{view().weightedLabel}</h3>
          <p class="tps-value">
            <RateValue value={view().weighted.value} unit={view().weighted.unit} />
          </p>
          <p class="tps-scope">{view().scopeNote}</p>
          <p class="tps-simple-note">{view().weightedHint}</p>
        </div>
      </div>
      <p class="tps-simple-explain">{view().explanation}</p>
    </section>
  );
}

function TrendChart(props: { samples: readonly TpsSample[]; lang?: Language }) {
  const l = () => langOf(props.lang);
  const points = () => trendPoints(props.samples, TREND_MAX_POINTS);
  const measured = () => points().filter((p) => !p.gap && p.tps !== null);
  const axis = () => trendAxis(points());
  const segments = () => splitTrendSegments(points());
  const xOf = (id: string): number => trendPointX(points().findIndex((p) => p.id === id), points().length);
  const yOf = (point: TrendPoint): number => trendPointY(point.tps, axis().max) ?? TREND_Y_BOTTOM;
  const lineFor = (seg: readonly TrendPoint[]): string =>
    seg.map((p) => `${xOf(p.id).toFixed(2)},${yOf(p).toFixed(2)}`).join(" ");
  const topLabel = (): string => splitFormattedRate(formatTps(axis().max, l())).value;
  const midLabel = (): string | null => {
    const mid = axis().mid;
    return mid === null ? null : splitFormattedRate(formatTps(mid, l())).value;
  };
  const summary = () => {
    const m = measured();
    if (m.length === 0) return t(l(), "trend.empty");
    return trendSummary(l(), m.length, formatTps(axis().max, l()));
  };
  const ariaCount = () => measured().length;
  const emptyMessage = () =>
    points().length === 0 ? t(l(), "trend.fallback") : t(l(), "trend.unmeasured");
  return (
    <div class="tps-trend-panel">
      <p class="tps-trend-title">{t(l(), "trend.title")}</p>
      <p class="tps-trend-desc">{t(l(), "trend.description")}</p>
      <Show when={measured().length > 0} fallback={<p class="tps-trend-empty">{emptyMessage()}</p>}>
        <div class="tps-chart" dir="ltr">
          <span class="tps-chart-unit">{t(l(), "trend.unit")}</span>
          <div class="tps-chart-y" aria-hidden="true">
            <span>{axis().allZero ? "" : topLabel()}</span>
            <Show when={midLabel() !== null}>
              <span>{midLabel()}</span>
            </Show>
            <span>0</span>
          </div>
          <div class="tps-chart-plot">
            <svg
              class="tps-trend"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              role="img"
              aria-label={t(l(), "trend.aria", { count: ltrText(formatTokens(ariaCount(), l()), l()), summary: summary() })}
            >
              <title>{summary()}</title>
              <g class="tps-trend-grid" aria-hidden="true">
                <line x1="0" y1={TREND_Y_TOP} x2="100" y2={TREND_Y_TOP} vector-effect="non-scaling-stroke" />
                <line x1="0" y1="50" x2="100" y2="50" vector-effect="non-scaling-stroke" />
                <line x1="0" y1={TREND_Y_BOTTOM} x2="100" y2={TREND_Y_BOTTOM} vector-effect="non-scaling-stroke" />
              </g>
              <For each={segments()}>
                {(seg) => (
                  <Show when={seg.length > 1}>
                    <polyline
                      points={lineFor(seg)}
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      vector-effect="non-scaling-stroke"
                    />
                  </Show>
                )}
              </For>
            </svg>
            <div class="tps-chart-dots" aria-hidden="true">
              <For each={measured()}>
                {(point) => (
                  <span
                    class="tps-chart-dot"
                    style={{ left: `${xOf(point.id)}%`, top: `${yOf(point)}%` }}
                  />
                )}
              </For>
            </div>
          </div>
          <div class="tps-chart-x" aria-hidden="true">
            <span>{t(l(), "trend.axisOlder")}</span>
            <span>{t(l(), "trend.axisX")}</span>
            <span>{t(l(), "trend.axisNewer")}</span>
          </div>
          <p class="tps-chart-legend">
            <span class="tps-chart-swatch" aria-hidden="true" />
            {t(l(), "trend.legend")}
          </p>
          <Show when={axis().allZero}>
            <p class="tps-trend-note">{t(l(), "trend.allZero")}</p>
          </Show>
        </div>
      </Show>
      <p class="tps-hint">{t(l(), "trend.hint", { max: ltrText(formatTokens(TREND_MAX_POINTS, l()), l()) })}</p>
    </div>
  );
}

function HistoryTable(props: {
  samples: readonly TpsSample[];
  visible: number;
  onMore: () => void;
  lang?: Language;
}) {
  const l = () => langOf(props.lang);
  const rows = () => historyWindow(props.samples, props.visible);
  const remaining = () => Math.max(0, [...props.samples].length - props.visible);
  return (
    <div>
      <div class="tps-table-wrap">
        <table class="tps-table">
          <caption style={{ display: "none" }}>{t(l(), "history.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t(l(), "history.model")}</th>
              <th scope="col">{t(l(), "history.speed")}</th>
              <th scope="col">{t(l(), "history.speedWall")}</th>
              <th scope="col">{t(l(), "history.output")}</th>
              <th scope="col">{t(l(), "history.reasoning")}</th>
              <th scope="col">{t(l(), "history.active")}</th>
              <th scope="col">{t(l(), "history.total")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(s) => (
                <tr>
                  <td>
                    <span class="tps-model" title={s.model}>
                      <Natural value={shortModel(s.model)} />
                    </span>
                  </td>
                  <td><Ltr value={formatTps(s.primaryTps, l())} /></td>
                  <td><Ltr value={formatTps(s.wallTps, l())} /></td>
                  <td><Ltr value={formatTokens(s.output, l())} /></td>
                  <td><Ltr value={formatTokens(s.reasoning, l())} /></td>
                  <td><Ltr value={s.activeDurationMs === null ? "—" : formatDuration(s.activeDurationMs, l())} /></td>
                  <td><Ltr value={formatDuration(s.durationMs, l())} /></td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <Show when={remaining() > 0}>
        <button type="button" class="tps-more" onClick={props.onMore}>
          {t(l(), "action.showMore", { remaining: ltrText(formatTokens(remaining(), l()), l()) })}
        </button>
      </Show>
    </div>
  );
}

function AboutMethod(props: { lang?: Language }) {
  const l = () => langOf(props.lang);
  return (
    <details class="tps-about">
      <summary>{t(l(), "about.summary")}</summary>
      <p>{t(l(), "about.body")}</p>
      <p>{t(l(), "about.live")}</p>
    </details>
  );
}

/**
 * Single stable partial disclosure in the toolbar. The reserved 18px slot is
 * always present (inert placeholder when nothing is partial), so showing or
 * hiding the notice never shifts toolbar geometry; the full detail opens in
 * an absolutely positioned popover inside the root, never as an in-flow
 * banner above the hero. Native details/summary keeps it keyboard operable.
 */
function PartialFlag(props: { notes: () => readonly string[]; lang?: Language }) {
  const l = () => langOf(props.lang);
  return (
    <Show when={props.notes().length > 0} fallback={<span class="tps-flag-ph" aria-hidden="true" />}>
      <details class="tps-flag">
        <summary class="tps-flag-btn" aria-label={t(l(), "partial.details")} title={t(l(), "partial.details")}>
          i
        </summary>
        <div class="tps-flag-pop" role="note">
          <For each={props.notes()}>{(n) => <p>{n}</p>}</For>
        </div>
      </details>
    </Show>
  );
}

/** Reserved live activity/TTFT row, separate from the final-only hero pair. */
function LiveActivityRow(props: {
  live?: LiveScopeSnapshot | null;
  lang?: Language;
  estimateEnabled?: boolean;
  onEstimateChange?: (next: boolean) => void;
  finalRate: string | null;
  scopeLabel: string;
  compact?: boolean;
}) {
  const l = () => langOf(props.lang);
  const enabled = () => props.estimateEnabled !== false;
  const row = () => liveRowPresentation(props.live, l(), enabled(), props.finalRate);
  return (
    <section class="tps-live" aria-label={t(l(), "live.rowAria")}>
      <p class="tps-live-scope">{t(l(), "live.sessionScope", { scope: props.scopeLabel })}</p>
      <dl class="tps-live-grid">
        <div class="tps-live-cell">
          <dt>{t(l(), "live.activityLabel")}</dt>
          <dd>{row().activity}</dd>
          <p class="tps-live-detail">{row().detail || "\u00a0"}</p>
        </div>
        <div class="tps-live-cell">
          <dt>{t(l(), "live.estimateLabel")}</dt>
          <dd class="tps-live-estimate" data-live={row().approximate ? "true" : "false"}>
            {row().estimate}
          </dd>
        </div>
        <div class="tps-live-cell">
          <dt>{t(l(), "live.ttftLabel")}</dt>
          <dd>{row().ttft}</dd>
        </div>
      </dl>
      <div class="tps-live-controls">
        <LiveEstimateSwitch
          checked={enabled()}
          onChange={(next) => props.onEstimateChange?.(next)}
          lang={l()}
        />
        <span class="tps-hint">
          {t(l(), props.compact === true ? "live.approxShort" : "live.approxNote")}
        </span>
      </div>
    </section>
  );
}

function Toolbar(props: {
  connected: boolean;
  partial: boolean;
  refreshing: boolean;
  notes: () => readonly string[];
  onRefresh: () => void;
  lang: Language;
  onLanguage: (next: Language) => void;
  langId: string;
  viewMode: ViewMode;
  onViewMode: (next: ViewMode) => void;
}) {
  const l = () => langOf(props.lang);
  const state = () => toolbarStatePresentation(props.connected, props.partial, l());
  return (
    <div class="tps-bar">
      <span class="tps-wordmark">TPSTracer</span>
      <ViewModeControl value={props.viewMode} onChange={props.onViewMode} lang={l()} />
      <span class="tps-spacer" />
      <Show when={state().text}>
        <span class="tps-state" data-tone={state().tone ?? undefined} role="status">
          {state().text}
        </span>
      </Show>
      <PartialFlag notes={props.notes} lang={l()} />
      <span class="tps-sync" data-active={props.refreshing ? "true" : "false"} aria-hidden="true">
        <span class="tps-sync-dot" />
      </span>
      <SelectionPopover
        id={props.langId}
        class="tps-lang-menu"
        label={t(l(), "language.label")}
        value={l()}
        options={LANGUAGE_OPTIONS}
        onChange={(next) => props.onLanguage(normalizeLanguage(next))}
        lang={l()}
        align="end"
      />
      <button
        type="button"
        class="tps-refresh tps-refresh-icon"
        onClick={props.onRefresh}
        aria-label={t(l(), "action.refreshAria")}
        title={t(l(), "action.refresh")}
      >
        <span aria-hidden="true">↻</span>
      </button>
    </div>
  );
}

/** All-session model overview: root plus verified descendants, independent of selection. */
function ModelOverview(props: { tree: TreeSnapshot; lang?: Language }) {
  const l = () => langOf(props.lang);
  const [keeper, setKeeper] = createSignal({ root: props.tree.rootSessionID, visible: MODELS_INITIAL_COUNT });
  const inventory = createMemo(() => inventoryFromTree("", props.tree));
  // Preserve expansion on same root across events/language; reset only on root change.
  createEffect(() => {
    const root = props.tree.rootSessionID;
    setKeeper((prev) => nextModelsVisibleState(prev, root, MODELS_INITIAL_COUNT));
  });
  const visible = () => keeper().visible;
  const entryMap = createMemo(() => new Map(inventory().entries.map((e) => [e.key, e] as const)));
  const keys = () => limitList(inventory().entries.map((e) => e.key), visible());
  const remaining = () => Math.max(0, inventory().entries.length - visible());
  const rootID = () => props.tree.rootSessionID;
  const sessionName = (s: { sessionID: string; title: string | null }): string => {
    if (s.sessionID === rootID()) return rootScopeLabel(props.tree.children.length, l());
    return s.title ?? s.sessionID;
  };
  const agentsText = (agents: readonly (string | null)[]): string =>
    agents.map((a) => agentText(a, l())).join(", ");
  const inv = () => inventory();
  // Reserved single-line status region (always mounted, fixed geometry):
  // coverage when data exists, loading/empty/disconnected otherwise.
  // Partial detail lives in the toolbar disclosure (stable, no in-flow
  // banner flicker); the coverage counts themselves stay honest
  // (measured vs observed) and the toolbar spinner covers background work.
  const note = () => modelStatusNote(inv(), l());
  return (
    <section class="tps-section" aria-label={t(l(), "section.modelsAria")}>
      <h3>{t(l(), "section.modelsScope")}</h3>
      <p class="tps-hint">{t(l(), "models.hint")}</p>
      <p class="tps-models-note" role="status">{note()}</p>
      <Show when={inv().entries.length > 0}>
        <div>
          <ul class="tps-agents" aria-label={t(l(), "section.modelsAria")}>
            <For each={keys()}>
              {(key) => {
                const e = () => entryMap().get(key)!;
                const provKeys = () => e().sessions.map((s) => sessionScopeKey(s.serverID, s.sessionID));
                const provMap = () => new Map(e().sessions.map((s) => [sessionScopeKey(s.serverID, s.sessionID), s] as const));
                return (
                  <li class="tps-agent" data-key={key}>
                    <details>
                      <summary class="tps-agent-head">
                        <span class="tps-agent-name" title={e().label}>
                          <Natural value={shortModel(e().label)} />
                        </span>
                        <span class="tps-agent-state">
                          {e().measuredActive > 0 ? <Ltr value={formatTps(e().weightedPrimaryTps, l())} /> : t(l(), "models.unmeasured")} ·{" "}
                          {t(l(), "models.measured", { measured: ltrText(formatTokens(e().measuredActive, l()), l()), observed: ltrText(formatTokens(e().observed, l()), l()) })}
                        </span>
                      </summary>
                      <div class="tps-agent-body">
                        <div class="tps-agent-metrics">
                          <span>
                            {t(l(), "models.activeRate", {
                              rate: e().measuredActive > 0 ? ltrText(formatTps(e().weightedPrimaryTps, l()), l()) : "—",
                            })}
                          </span>
                          <span>
                            {t(l(), "models.wallRate", {
                              rate: e().measuredWall > 0 ? ltrText(formatTps(e().weightedWallTps, l()), l()) : "—",
                            })}
                          </span>
                          <span>
                            {t(l(), "models.measuredUsage")}:{" "}
                            {t(l(), "subagents.outputReasoning", {
                              output: ltrText(formatTokens(e().totalOutput, l()), l()),
                              reasoning: ltrText(formatTokens(e().totalReasoning, l()), l()),
                            })}
                          </span>
                          <span>{t(l(), "models.sessions", { count: ltrText(formatTokens(e().sessions.length, l()), l()) })}</span>
                          <span>{agentsText(e().agents)}</span>
                        </div>
                        <ul class="tps-model-prov">
                          <For each={provKeys()}>
                            {(pk) => {
                              const s = () => provMap().get(pk)!;
                              return (
                                <li data-key={pk}>
                                  <span class="tps-model" title={s().sessionID}>
                                    <Natural value={shortModel(sessionName(s()))} />
                                  </span>
                                  {" · "}
                                  {agentsText(s().agents.length > 0 ? s().agents : [s().agent])}
                                  {" · "}
                                  {t(l(), "models.measured", { measured: ltrText(formatTokens(s().measuredActive, l()), l()), observed: ltrText(formatTokens(s().observed, l()), l()) })}
                                </li>
                              );
                            }}
                          </For>
                        </ul>
                      </div>
                    </details>
                  </li>
                );
              }}
            </For>
          </ul>
          <Show when={remaining() > 0}>
            <button type="button" class="tps-more" onClick={() => setKeeper((k) => ({ root: k.root, visible: k.visible + MODELS_STEP }))}>
              {t(l(), "models.showMore", { remaining: ltrText(formatTokens(remaining(), l()), l()) })}
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}

/** Full session/delegate dashboard with session scope selection. */
export function TreePanelView(props: {
  tree: TreeSnapshot;
  connected: boolean;
  mode: "light" | "dark";
  onRetry: () => void;
  onRefresh: () => void;
  lang?: Language;
  onLanguage?: (next: Language) => void;
  live?: readonly LiveScopeSnapshot[];
  estimateEnabled?: boolean;
  onEstimateChange?: (next: boolean) => void;
  viewMode?: ViewMode;
  onViewMode?: (next: ViewMode) => void;
}) {
  const l = () => langOf(props.lang);
  const view = () => dashboardViewPolicy(props.viewMode);
  const [selectedID, setSelectedID] = createSignal<string>(props.tree.rootSessionID);
  const [agentSel, setAgentSel] = createSignal<AgentSelection>(ALL_AGENTS);
  const [visible, setVisible] = createSignal(HISTORY_INITIAL_ROWS);
  const [agentsVisible, setAgentsVisible] = createSignal(AGENTS_INITIAL_COUNT);

  const tree = () => props.tree;
  const resolved = () => resolveScope(tree(), selectedID(), l());

  // Reset safely when the root changes or the selected scope disappears:
  // navigation itself never depends on data, so no selection can trap the user.
  // Language changes never reset selection: `resolved` label follows `l()`
  // but the stored `selectedID` only changes here when unknown.
  createEffect(() => {
    const r = resolved();
    if (!r.known) {
      setSelectedID(r.sessionID);
      setAgentSel(ALL_AGENTS);
      setVisible(HISTORY_INITIAL_ROWS);
    }
  });

  const selectScope = (id: string) => {
    if (!isKnownScope(tree(), id)) return;
    setSelectedID(id);
    setAgentSel(ALL_AGENTS);
    setVisible(HISTORY_INITIAL_ROWS);
  };

  const selectedSnapshot = (): AdapterSnapshot => {
    const t = tree();
    const id = resolved().sessionID;
    if (id === t.rootSessionID) return t.root;
    return t.children.find((c) => c.sessionID === id)?.snapshot ?? t.root;
  };

  const snap = () => selectedSnapshot();
  const groups = createMemo(() => groupByAgent(snap().samples, snap().observations));

  // Reset the agent filter when its agent vanishes (new root, pruned scope).
  createEffect(() => {
    const valid = normalizeAgentSelection(
      groups().map((g) => g.agent),
      agentSel(),
    );
    if (valid !== agentSel()) {
      setAgentSel(valid);
      setVisible(HISTORY_INITIAL_ROWS);
    }
  });

  const scopedSamples = () => samplesForAgentSelection(snap().samples, agentSel());
  const scopedObservations = () => observationsForAgentSelection(snap().observations ?? [], agentSel());
  const scopedSummary = createMemo(() => summarize(scopedSamples(), scopedObservations()));
  const liveForScope = () => liveSnapshotFor(props.live, resolved().sessionID);
  const liveFinalRate = (): string | null => sessionFinalRate(snap().summary, l());
  const scopeName = (): string => {
    const sel = agentSel();
    if (sel.kind === "agent") {
      return t(l(), "scope.childName", { agent: agentText(sel.agent, l()) });
    }
    return resolved().label;
  };

  const policy = () => scopeRenderPolicy(tree().status, snap());
  const showData = () => policy().showContent;
  const refreshing = () => policy().refreshing;
  const disconnected = () => !props.connected || tree().status === "disconnected";
  // Sticky partial reason data per key: live snapshots clear their reason
  // while reloading, so the toolbar disclosure keeps the last honest data
  // across partial→loading→partial refreshes. A scope/root change always
  // takes the new key's live value, never another scope's data as its own.
  // Stored as codes/data so a language change retranslates immediately.
  const [treeReason, setTreeReason] = createSignal<PartialReasonState>({ key: "", reason: null, verbatim: null });
  const [scopeReason, setScopeReason] = createSignal<PartialReasonState>({ key: "", reason: null, verbatim: null });
  createEffect(() => {
    const t = tree();
    const isPartial = t.partial;
    setTreeReason((s) =>
      nextPartialReason(
        s,
        t.rootSessionID,
        isPartial ? (t.errorReason ?? null) : null,
        isPartial && !t.errorReason ? (t.error ?? null) : null,
        refreshing(),
      ),
    );
  });
  createEffect(() => {
    const key = resolved().sessionID;
    const s = snap();
    const isPartial = s.status === "partial";
    setScopeReason((prev) =>
      nextPartialReason(
        prev,
        key,
        isPartial ? (s.reason ?? null) : null,
        isPartial && !s.reason ? (s.error ?? null) : null,
        refreshing(),
      ),
    );
  });
  const partialNow = () =>
    treeReason().reason !== null ||
    treeReason().verbatim !== null ||
    scopeReason().reason !== null ||
    scopeReason().verbatim !== null;
  const partialNotes = (): readonly string[] => {
    const out: string[] = [];
    const tr = treeReason();
    if (tr.reason !== null || tr.verbatim !== null)
      out.push(
        t(l(), "partial.treeNote", {
          reason: reasonDisplay(tr.reason, tr.verbatim, l(), { kind: "subagent-unavailable" }),
        }),
      );
    const sr = scopeReason();
    if (sr.reason !== null || sr.verbatim !== null)
      out.push(
        t(l(), "partial.scopeNote", {
          scope: scopeName(),
          reason: reasonDisplay(sr.reason, sr.verbatim, l(), { kind: "scope-incomplete" }),
        }),
      );
    return out;
  };
  const agents = () => tree().children;
  const shownAgents = () => limitList(agents(), agentsVisible());
  const remainingAgents = () => Math.max(0, agents().length - agentsVisible());
  const setLang = (next: Language) => props.onLanguage?.(next);

  return (
    <section
      class="tps-root"
      data-tps-mode={props.mode}
      lang={l()}
      dir={languageDirection(l())}
      aria-label={t(l(), "panel.ariaTree")}
      aria-busy={refreshing() ? "true" : "false"}
    >
      <Toolbar
        connected={!disconnected()}
        partial={partialNow()}
        refreshing={refreshing()}
        notes={partialNotes}
        onRefresh={props.onRefresh}
        lang={l()}
        onLanguage={setLang}
        langId="tps-lang-select"
        viewMode={view().mode}
        onViewMode={(next) => props.onViewMode?.(next)}
      />

      <Show when={disconnected()}>
        <div class="tps-status" role="status">
          <p>{t(l(), "status.disconnectedDetail")}</p>
        </div>
      </Show>

      <Show when={!disconnected()}>
        <div class="tps-field">
          <label for="tps-scope-trigger">{t(l(), "scope.label")}</label>
          <SelectionPopover
            id="tps-scope"
            class="tps-scope-menu"
            label={t(l(), "scope.label")}
            value={resolved().sessionID}
            options={scopeOptionsFor(tree(), l()).map((opt) => ({
              value: opt.sessionID,
              label: opt.label,
              detail: opt.detail,
            }))}
            onChange={selectScope}
            lang={l()}
          />
        </div>

        <LiveActivityRow
          live={liveForScope()}
          lang={l()}
          estimateEnabled={props.estimateEnabled}
          onEstimateChange={props.onEstimateChange}
          finalRate={liveFinalRate()}
          scopeLabel={resolved().label}
          compact={view().simple}
        />

        <Show when={snap().status === "error"}>
          <div class="tps-status tps-error" role="alert">
            <p>
              {t(l(), "scope.error", {
                scope: scopeName(),
                reason: snapshotErrorText(snap(), l()),
              })}
            </p>
            <button type="button" class="tps-refresh" onClick={props.onRetry}>
              {t(l(), "action.retry")}
            </button>
          </div>
        </Show>

        <Show when={policy().showLoading}>
          <div class="tps-status" role="status" aria-busy="true">
            <p>{t(l(), "scope.loading", { scope: scopeName() })}</p>
          </div>
        </Show>

        <Show when={snap().status === "empty"}>
          <div class="tps-status" role="status">
            <p>{t(l(), "scope.empty", { scope: scopeName() })}</p>
          </div>
        </Show>

        <Show when={snap().status === "disconnected"}>
          <div class="tps-status" role="status">
            <p>{t(l(), "status.disconnectedDetail")}</p>
          </div>
        </Show>

        <Show when={view().simple && showData()}>
          <SimpleSummary summary={scopedSummary()} scopeName={scopeName()} lang={l()} />
        </Show>

        <div class="tps-detailed" hidden={view().detailedHidden}>
          <Show when={showData()}>
            <HeroCards
              summary={scopedSummary()}
              scopeName={scopeName()}
              lang={l()}
            />
          <dl class="tps-stats" aria-label={t(l(), "totals.ariaScope", { scope: scopeName() })}>
            <div class="tps-stat">
              <dt>{t(l(), "totals.output")}</dt>
              <dd><Ltr value={scopedSummary().count > 0 ? formatTokens(scopedSummary().totalOutput, l()) : "—"} /></dd>
            </div>
            <div class="tps-stat">
              <dt>{t(l(), "totals.reasoning")}</dt>
              <dd><Ltr value={scopedSummary().count > 0 ? formatTokens(scopedSummary().totalReasoning, l()) : "—"} /></dd>
            </div>
            <div class="tps-stat">
              <dt>{t(l(), "totals.generated")}</dt>
              <dd><Ltr value={scopedSummary().activeCount > 0 ? formatTokens(scopedSummary().totalGenerated, l()) : "—"} /></dd>
            </div>
            <div class="tps-stat">
              <dt>{t(l(), "totals.responses")}</dt>
              <dd><Ltr value={formatTokens(scopedSummary().completedCount, l())} /></dd>
            </div>
            <div class="tps-stat">
              <dt>{t(l(), "totals.failed")}</dt>
              <dd><Ltr value={formatTokens(scopedSummary().failedCount, l())} /></dd>
            </div>
            <div class="tps-stat">
              <dt>{t(l(), "totals.unfinished")}</dt>
              <dd><Ltr value={formatTokens(scopedSummary().unfinishedCount, l())} /></dd>
            </div>
          </dl>

          <section class="tps-section" aria-label={t(l(), "section.trendAria")}>
            <h3>{t(l(), "section.trendScope", { scope: scopeName() })}</h3>
            <TrendChart samples={scopedSamples()} lang={l()} />
          </section>

          <Show when={groups().length > 1}>
            <section class="tps-section" aria-label={t(l(), "section.agentsAria")}>
              <h3>{t(l(), "section.agents")}</h3>
              <div class="tps-scopes" role="group" aria-label={t(l(), "section.agentsGroup")}>
                <button
                  type="button"
                  class="tps-scope-btn"
                  aria-pressed={agentSel().kind === "all"}
                  onClick={() => {
                    setAgentSel(ALL_AGENTS);
                    setVisible(HISTORY_INITIAL_ROWS);
                  }}
                >
                  {t(l(), "agent.all")}
                </button>
                <For each={groups()}>
                  {(g) => (
                    <button
                      type="button"
                      class="tps-scope-btn"
                      aria-pressed={isAgentSelected(agentSel(), g.agent)}
                      title={
                        g.agent === null
                          ? t(l(), "agent.noKnown")
                          : t(l(), "agent.from", { agent: agentText(g.agent, l()) })
                      }
                      onClick={() => {
                        setAgentSel(agentSelectionOf(g.agent));
                        setVisible(HISTORY_INITIAL_ROWS);
                      }}
                    >
                      <Natural value={agentSelectionLabel(agentSelectionOf(g.agent), l())} /> ·{" "}
                      <Ltr value={formatTokens(g.summary.completedCount, l())} />
                    </button>
                  )}
                </For>
              </div>
            </section>
          </Show>

          <section class="tps-section" aria-label={t(l(), "section.historyScopeAria", { scope: scopeName() })}>
            <h3>{t(l(), "section.historyScope", { scope: scopeName() })}</h3>
            <HistoryTable
              samples={scopedSamples()}
              visible={visible()}
              onMore={() => setVisible((v) => v + HISTORY_STEP)}
              lang={l()}
            />
          </section>
        </Show>

        <Show when={agents().length > 0}>
          <details class="tps-section tps-agents-box">
            <summary>
              {t(l(), "subagents.title", { count: ltrText(formatTokens(agents().length, l()), l()) })}
              <Show when={treeReason().reason !== null || treeReason().verbatim !== null}>
                {t(l(), "subagents.partial")}
              </Show>
            </summary>
            <ul class="tps-agents" aria-label={t(l(), "subagents.aria")}>
              <For each={shownAgents()}>
                {(c) => (
                  <li class="tps-agent">
                    <details>
                      <summary class="tps-agent-head">
                        <span class="tps-agent-name" title={c.title ?? agentLabel(c.agent, l())}>
                          <Natural value={c.title ?? agentLabel(c.agent, l())} />
                        </span>
                        <span class="tps-agent-depth">{t(l(), "subagents.level", { depth: ltrText(formatTokens(c.depth, l()), l()) })}</span>
                        <span class="tps-agent-state">
                          <Show
                            when={hasScopeContent(c.snapshot)}
                            fallback={
                              c.snapshot.status === "error"
                                ? t(l(), "subagents.unavailable")
                                : c.snapshot.status === "empty"
                                  ? t(l(), "subagents.noResponses")
                                  : c.snapshot.status === "disconnected"
                                    ? t(l(), "subagents.disconnected")
                                    : t(l(), "subagents.loading")
                            }
                          >
                            <Ltr value={formatTps(latestMeasurement(c.snapshot.summary).primary, l())} /> ·{" "}
                            {t(l(), c.snapshot.summary.completedCount === 1 ? "subagents.countOne" : "subagents.countOther", {
                              count: ltrText(formatTokens(c.snapshot.summary.completedCount, l()), l()),
                            })}
                          </Show>
                        </span>
                      </summary>
                      <div class="tps-agent-body">
                        <Show when={c.title}>
                          <p class="tps-agent-meta">
                            {t(l(), "agent.withTitle", { label: agentText(c.agent, l()) })}
                            <Show when={c.agent === null}> {t(l(), "agent.unknownShort")}</Show>
                          </p>
                        </Show>
                        <Show when={!c.title && c.agent === null}>
                          <p class="tps-agent-meta">{t(l(), "agent.unknownFull")}</p>
                        </Show>
                        <Show when={latestMeasurement(c.snapshot.summary).hasLatest}>
                          <p class="tps-agent-meta">
                            {t(l(), "subagents.model")}
                            <span class="tps-model" title={latestMeasurement(c.snapshot.summary).model ?? ""}>
                              <Natural value={shortModel(latestMeasurement(c.snapshot.summary).model ?? "—")} />
                            </span>
                          </p>
                        </Show>
                        <div class="tps-agent-metrics">
                          <Show
                            when={hasScopeContent(c.snapshot)}
                            fallback={
                              <span class="tps-agent-empty">
                                {c.snapshot.status === "error"
                                  ? t(l(), "subagents.unavailableDetail", {
                                      reason: snapshotErrorText(c.snapshot, l()),
                                    })
                                  : c.snapshot.status === "disconnected"
                                    ? t(l(), "subagents.disconnectedDetail")
                                    : c.snapshot.status === "empty"
                                      ? t(l(), "subagents.emptyDetail")
                                      : t(l(), "subagents.loadingDetail")}
                              </span>
                            }
                          >
                            <span>
                              {t(l(), "subagents.latest", {
                                rate: ltrText(formatTps(latestMeasurement(c.snapshot.summary).primary, l()), l()),
                              })}
                            </span>
                            <span>
                              {t(l(), "hero.secondary", {
                                rate: ltrText(formatTps(latestMeasurement(c.snapshot.summary).wall, l()), l()),
                              })}
                            </span>
                            <span>
                              {t(l(), "subagents.average", {
                                rate: ltrText(formatTps(c.snapshot.summary.weightedPrimaryTps, l()), l()),
                              })}
                            </span>
                            <span>
                              {t(l(), "hero.secondary", {
                                rate: ltrText(formatTps(c.snapshot.summary.weightedTps, l()), l()),
                              })}
                            </span>
                            <span>
                              {t(l(), "subagents.outputReasoning", {
                                output: ltrText(c.snapshot.summary.count > 0 ? formatTokens(c.snapshot.summary.totalOutput, l()) : "—", l()),
                                reasoning: ltrText(c.snapshot.summary.count > 0 ? formatTokens(c.snapshot.summary.totalReasoning, l()) : "—", l()),
                              })}
                            </span>
                          </Show>
                        </div>
                        <div class="tps-agent-actions">
                          <button type="button" class="tps-more" onClick={() => selectScope(c.sessionID)}>
                            {t(l(), "action.viewMetrics")}
                          </button>
                          <Show when={c.snapshot.status === "error"}>
                            <button type="button" class="tps-refresh" onClick={props.onRetry}>
                              {t(l(), "action.retry")}
                            </button>
                          </Show>
                        </div>
                      </div>
                    </details>
                  </li>
                )}
              </For>
            </ul>
            <Show when={remainingAgents() > 0}>
              <button type="button" class="tps-more" onClick={() => setAgentsVisible((v) => v + AGENTS_STEP)}>
                {t(l(), "action.showMoreAgents", { remaining: ltrText(formatTokens(remainingAgents(), l()), l()) })}
              </button>
            </Show>
          </details>
        </Show>

          <ModelOverview tree={tree()} lang={l()} />
        </div>
      </Show>
      <div class="tps-detailed" hidden={view().detailedHidden}>
        <AboutMethod lang={l()} />
      </div>
    </section>
  );
}
