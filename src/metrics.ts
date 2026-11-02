/**
 * Pure provider-active and wall-clock throughput calculations for TPSTracer.
 *
 * Primary (provider-active generated TPS):
 * `(output + reasoning) / ((streamed - created) / 1000)`, requiring explicit
 * finite nonnegative output AND reasoning plus `created < streamed <=
 * completed` on a completed successful step. `streamed` is the provider-stream
 * END marker (before post-stream local-tool waiting), not first-token time.
 *
 * Secondary (wall-clock output TPS):
 * `output / ((completed - created) / 1000)`, independent of streamed/reasoning
 * absence. Never used as an invisible fallback under a provider-active label.
 *
 * Time-unit evidence (installed published artifact
 * `@opencode/client@2.2.0`, `dist/chunks/service-timing-*.js`): the client
 * admits session message shapes with `time: { created: Date.now() }`, i.e.
 * epoch milliseconds. The generated contract
 * (`SessionMessageAssistant.time: { created: number; streamed?: number;
 * completed?: number }`) does not document a unit, so milliseconds remain an
 * explicit assumption: the UI labels it as such and durations must be read
 * with that caveat. Reasoning tokens are reported separately and a missing
 * reasoning count is unknown (null), never zero.
 */

import type { Language } from "./definition.js";
import { LANGUAGE_META, LANGUAGES, normalizeLanguage } from "./definition.js";

export interface TokenUsageLike {
  readonly output?: unknown;
  readonly reasoning?: unknown;
}

export interface AssistantMessageLike {
  readonly id: string;
  readonly agent?: unknown;
  readonly model?: { readonly providerID?: unknown; readonly id?: unknown; readonly variant?: unknown };
  readonly tokens?: TokenUsageLike | null;
  readonly time?: { readonly created?: unknown; readonly streamed?: unknown; readonly completed?: unknown } | null;
  readonly error?: unknown;
  readonly finish?: unknown;
}

export interface TpsSample {
  readonly id: string;
  /** Agent that produced the response, or null when the host omitted it. Never invented. */
  readonly agent: string | null;
  readonly model: string;
  readonly output: number;
  /** Reasoning tokens, or null when the host omitted the count. */
  readonly reasoning: number | null;
  readonly created: number;
  /** Provider-stream end marker, or null when the host omitted it. */
  readonly streamed: number | null;
  readonly completed: number;
  /** Wall-clock duration (completed - created) in ms. */
  readonly durationMs: number;
  /** Provider-active duration (streamed - created) in ms, or null when unavailable. */
  readonly activeDurationMs: number | null;
  /** Generated tokens (output + reasoning) when both counts are explicit, else null. */
  readonly generated: number | null;
  /** Effective output tokens per second (wall-clock). Real zero is valid. */
  readonly tps: number;
  /** Explicit wall-clock alias of `tps`; kept so primary never hides behind this unit. */
  readonly wallTps: number;
  /** Provider-active generated tokens per second, or null when unavailable. Never a wall fallback. */
  readonly primaryTps: number | null;
}

export interface TpsSummary {
  readonly count: number;
  readonly totalOutput: number;
  /**
   * Total reasoning tokens, or null when any sample's count is unknown
   * (partial semantics: a number here is exact only when every sample
   * reported reasoning).
   */
  readonly totalReasoning: number | null;
  readonly totalDurationMs: number;
  /** Weighted wall-clock throughput (totalOutput / totalSeconds), or null when empty. */
  readonly weightedTps: number | null;
  /** Weighted provider-active throughput over active-eligible pairs only, else null. */
  readonly weightedPrimaryTps: number | null;
  /** Samples with a valid provider-active pair (measured active observations). */
  readonly activeCount: number;
  /** Summed generated tokens over active-eligible pairs only. */
  readonly totalGenerated: number;
  /** Summed provider-active durations over active-eligible pairs only. */
  readonly totalActiveDurationMs: number;
  readonly last: TpsSample | null;
  /** Latest completed successful observation, even when unmeasured. Null when none. */
  readonly lastCompleted: TpsObservation | null;
  /** Completed successful observations (denominator for coverage). */
  readonly completedCount: number;
  /** Failed observations (error/finish:error), kept apart from coverage. */
  readonly failedCount: number;
  /** Unfinished observations (not failed, no valid completed interval). */
  readonly unfinishedCount: number;
}

/**
 * Minimal per-message observation, independent of rate eligibility.
 * Retained even for unfinished/failed/missing-usage responses with known
 * model metadata; unmeasured rows never fabricate tokens or rates.
 */
export interface TpsObservation {
  readonly id: string;
  readonly agent: string | null;
  readonly model: string;
  readonly provider: string | null;
  readonly modelId: string;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly created: number | null;
  readonly streamed: number | null;
  readonly completed: number | null;
  readonly failed: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export function modelLabel(msg: AssistantMessageLike): string {
  const provider = typeof msg.model?.providerID === "string" ? msg.model.providerID : "";
  const id = typeof msg.model?.id === "string" ? msg.model.id : "unknown";
  return provider ? `${provider}/${id}` : id;
}

export function modelProvider(msg: AssistantMessageLike): string | null {
  return typeof msg.model?.providerID === "string" && msg.model.providerID.length > 0
    ? msg.model.providerID
    : null;
}

export function modelIdOf(msg: AssistantMessageLike): string {
  return typeof msg.model?.id === "string" && msg.model.id.length > 0 ? msg.model.id : "unknown";
}

function agentOf(msg: AssistantMessageLike): string | null {
  return typeof msg.agent === "string" && msg.agent.length > 0 ? msg.agent : null;
}

function finiteOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function countOrNull(value: unknown): number | null {
  return isNonNegativeFinite(value) ? value : null;
}

/**
 * Minimal observation for one assistant message. Returns null only when the
 * message has no usable string id. Everything else is best-effort metadata:
 * unknown counts/timestamps stay null (never zero), failed flags mark
 * error/finish:error, and model identity comes from providerID/id.
 */
export function toObservation(msg: AssistantMessageLike | null | undefined): TpsObservation | null {
  if (!msg || typeof msg !== "object") return null;
  if (typeof msg.id !== "string" || msg.id.length === 0) return null;
  const tokens = msg.tokens && typeof msg.tokens === "object" ? msg.tokens : null;
  const time = msg.time && typeof msg.time === "object" ? msg.time : null;
  const failed =
    (msg.error !== undefined && msg.error !== null) || msg.finish === "error";
  return {
    id: msg.id,
    agent: agentOf(msg),
    model: modelLabel(msg),
    provider: modelProvider(msg),
    modelId: modelIdOf(msg),
    output: tokens ? countOrNull(tokens.output) : null,
    reasoning: tokens
      ? tokens.reasoning === undefined || tokens.reasoning === null
        ? null
        : countOrNull(tokens.reasoning)
      : null,
    created: time ? finiteOrNull(time.created) : null,
    streamed: time ? finiteOrNull(time.streamed) : null,
    completed: time ? finiteOrNull(time.completed) : null,
    failed,
  };
}

/** Collect minimal observations, preserving unmeasured/failed rows. */
export function collectObservations(messages: readonly AssistantMessageLike[]): TpsObservation[] {
  const out: TpsObservation[] = [];
  for (const m of messages) {
    const o = toObservation(m);
    if (o !== null) out.push(o);
  }
  return out;
}

/**
 * Build one wall-valid sample from a completed successful assistant message,
 * or null when wall eligibility fails: missing/invalid output, bad
 * created/completed, an error, `finish: "error"`, or otherwise unfinished.
 * Zero output with positive duration is a valid zero sample. A missing
 * reasoning count yields `reasoning: null` (unknown) with a preserved wall
 * rate and an unavailable primary; a present-but-invalid one excludes the
 * sample. Primary pairs explicit output + reasoning with streamed - created
 * (`created < streamed <= completed`); streamed is the provider-stream END
 * marker (after the provider stream, before local tool waiting), not first
 * token. Missing/invalid streamed, reasoning, ordering or non-finite
 * arithmetic leaves `primaryTps` null without touching the wall rate: no
 * invisible wall fallback ever appears under a provider-active label. The
 * latest response keeps its own primary value (including unavailable) and
 * never borrows an older eligible rate.
 */
export function toSample(msg: AssistantMessageLike | null | undefined): TpsSample | null {
  if (!msg || typeof msg !== "object") return null;
  if (typeof msg.id !== "string" || msg.id.length === 0) return null;
  // Any present error means failed/unfinished: never fabricate TPS.
  if (msg.error !== undefined && msg.error !== null) return null;
  // A failed finish without an error object is still failed.
  if (msg.finish === "error") return null;
  if (!msg.tokens || typeof msg.tokens !== "object") return null;
  const { output, reasoning } = msg.tokens;
  if (!isNonNegativeFinite(output)) return null;
  let reasoningCount: number | null = null;
  if (reasoning !== undefined && reasoning !== null) {
    if (!isNonNegativeFinite(reasoning)) return null;
    reasoningCount = reasoning;
  }
  if (!msg.time || typeof msg.time !== "object") return null;
  const { created, streamed, completed } = msg.time;
  if (!isFiniteNumber(created) || !isFiniteNumber(completed)) return null;
  const durationMs = completed - created;
  if (!isFiniteNumber(durationMs) || durationMs <= 0) return null;
  const tps = output / (durationMs / 1000);
  if (!isFiniteNumber(tps) || tps < 0) return null;
  const agent = agentOf(msg);
  const streamedOrNull = isFiniteNumber(streamed) ? streamed : null;
  let activeDurationMs: number | null = null;
  let generated: number | null = null;
  let primaryTps: number | null = null;
  if (reasoningCount !== null && streamedOrNull !== null) {
    const activeMs = streamedOrNull - created;
    if (
      isFiniteNumber(activeMs) &&
      activeMs > 0 &&
      created < streamedOrNull &&
      streamedOrNull <= completed
    ) {
      const gen = output + reasoningCount;
      if (isFiniteNumber(gen) && gen >= 0) {
        const rate = gen / (activeMs / 1000);
        if (isFiniteNumber(rate) && rate >= 0) {
          activeDurationMs = activeMs;
          generated = gen;
          primaryTps = rate;
        }
      }
    }
  }
  return {
    id: msg.id,
    agent,
    model: modelLabel(msg),
    output,
    reasoning: reasoningCount,
    created,
    streamed: streamedOrNull,
    completed,
    durationMs,
    activeDurationMs,
    generated,
    tps,
    wallTps: tps,
    primaryTps,
  };
}

/** Whether an observation finished successfully with a valid completed interval. */
export function isCompletedSuccessful(o: TpsObservation): boolean {
  if (o.failed) return false;
  if (o.created === null || o.completed === null) return false;
  return o.completed > o.created;
}

/** Weighted session summary. Latest keeps its own primary (possibly null). */
export function summarize(
  samples: readonly TpsSample[],
  observations?: readonly TpsObservation[],
): TpsSummary {
  let totalOutput = 0;
  let totalReasoning = 0;
  let reasoningUnknown = false;
  let totalDurationMs = 0;
  let totalGenerated = 0;
  let totalActiveDurationMs = 0;
  let activeCount = 0;
  let last: TpsSample | null = null;
  for (const s of samples) {
    totalOutput += s.output;
    if (s.reasoning === null) reasoningUnknown = true;
    else totalReasoning += s.reasoning;
    totalDurationMs += s.durationMs;
    if (s.primaryTps !== null && s.generated !== null && s.activeDurationMs !== null) {
      totalGenerated += s.generated;
      totalActiveDurationMs += s.activeDurationMs;
      activeCount += 1;
    }
    if (last === null || s.completed > last.completed || (s.completed === last.completed && s.id > last.id)) last = s;
  }
  const rawWall = samples.length === 0 || totalDurationMs <= 0 ? null : totalOutput / (totalDurationMs / 1000);
  const weightedTps = rawWall !== null && Number.isFinite(rawWall) && rawWall >= 0 ? rawWall : null;
  const rawPrimary =
    activeCount === 0 || totalActiveDurationMs <= 0 ? null : totalGenerated / (totalActiveDurationMs / 1000);
  const weightedPrimaryTps =
    rawPrimary !== null && Number.isFinite(rawPrimary) && rawPrimary >= 0 ? rawPrimary : null;
  let lastCompleted: TpsObservation | null = null;
  let completedCount = samples.length;
  let failedCount = 0;
  let unfinishedCount = 0;
  if (observations !== undefined) {
    completedCount = 0;
    for (const o of observations) {
      if (o.failed) {
        failedCount += 1;
        continue;
      }
      if (isCompletedSuccessful(o)) {
        completedCount += 1;
        if (
          lastCompleted === null ||
          (o.completed as number) > (lastCompleted.completed as number) ||
          ((o.completed as number) === (lastCompleted.completed as number) && o.id > lastCompleted.id)
        ) {
          lastCompleted = o;
        }
        continue;
      }
      unfinishedCount += 1;
    }
  }
  return {
    count: samples.length,
    totalOutput,
    totalReasoning: reasoningUnknown ? null : totalReasoning,
    totalDurationMs,
    weightedTps,
    weightedPrimaryTps,
    activeCount,
    totalGenerated,
    totalActiveDurationMs,
    last,
    lastCompleted,
    completedCount,
    failedCount,
    unfinishedCount,
  };
}

/** Collect valid samples from a mixed message list, skipping invalid ones. */
export function collectSamples(messages: readonly AssistantMessageLike[]): TpsSample[] {
  const out: TpsSample[] = [];
  for (const m of messages) {
    const s = toSample(m);
    if (s !== null) out.push(s);
  }
  return out;
}

/**
 * Display name for an agent scope; unknown agents stay localized
 * ("Unknown", "Desconocido", …), never invented. Defaults to English.
 */
export function agentLabel(agent: string | null | undefined, lang: Language = "en"): string {
  if (typeof agent === "string" && agent.length > 0) return agent;
  return LANGUAGE_META[normalizeLanguage(lang)].unknownAgent;
}

export interface AgentGroup {
  readonly agent: string | null;
  readonly samples: readonly TpsSample[];
  readonly summary: TpsSummary;
}

/**
 * Group samples by their retained per-response agent. Groups sort
 * alphabetically with the unknown group last; samples keep insertion order.
 * Each scope shows only its own samples: no cross-agent totals here.
 * When observations are provided, each group's summary counts completed
 * successful observations for that agent (coverage denominator), with
 * failed/unfinished kept apart.
 */
export function groupByAgent(
  samples: readonly TpsSample[],
  observations?: readonly TpsObservation[],
): AgentGroup[] {
  const byKey = new Map<string, TpsSample[]>();
  for (const s of samples) {
    const key = s.agent ?? "";
    const list = byKey.get(key);
    if (list) list.push(s);
    else byKey.set(key, [s]);
  }
  const obsByKey = new Map<string, TpsObservation[]>();
  if (observations !== undefined) {
    for (const o of observations) {
      const key = o.agent ?? "";
      const list = obsByKey.get(key);
      if (list) list.push(o);
      else obsByKey.set(key, [o]);
    }
    for (const key of obsByKey.keys()) {
      if (!byKey.has(key)) byKey.set(key, []);
    }
  }
  const keys = [...byKey.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return keys.map((key) => {
    const list = byKey.get(key) ?? [];
    const obs = observations !== undefined ? (obsByKey.get(key) ?? []) : undefined;
    return {
      agent: key === "" ? null : key,
      samples: list,
      summary: summarize(list, obs),
    };
  });
}

/**
 * Locale formatters for every supported language. They cache only Intl
 * formatting objects keyed by the explicit language; metric arithmetic and
 * availability rules stay untouched.
 */
const rateFormats: Record<Language, Intl.NumberFormat> = Object.fromEntries(
  LANGUAGES.map((lang) => [
    lang,
    new Intl.NumberFormat(LANGUAGE_META[lang].tag, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  ]),
) as Record<Language, Intl.NumberFormat>;
const intFormats: Record<Language, Intl.NumberFormat> = Object.fromEntries(
  LANGUAGES.map((lang) => [
    lang,
    new Intl.NumberFormat(LANGUAGE_META[lang].tag, { maximumFractionDigits: 0 }),
  ]),
) as Record<Language, Intl.NumberFormat>;

/** Locale-aware rate; calculations unchanged, default English (en-US). */
export function formatTps(tps: number | null | undefined, lang: Language = "en"): string {
  if (tps === null || tps === undefined) return "—";
  if (!Number.isFinite(tps) || tps < 0) return "—";
  return `${rateFormats[normalizeLanguage(lang)].format(tps)} tokens/s`;
}

/** Formats a token count with locale grouping for every supported language, or an em dash when unknown. */
export function formatTokens(count: number | null | undefined, lang: Language = "en"): string {
  if (count === null || count === undefined) return "—";
  if (!Number.isFinite(count) || count < 0) return "—";
  return intFormats[normalizeLanguage(lang)].format(count);
}

/** Locale-aware duration in seconds; default English (en-US). */
export function formatDuration(durationMs: number, lang: Language = "en"): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  return `${rateFormats[normalizeLanguage(lang)].format(durationMs / 1000)} s`;
}
