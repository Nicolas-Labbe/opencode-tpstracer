/**
 * Shared language, direction and diagnostic types for TPSTracer.
 *
 * Pure types and metadata only (no imports) so metric, presentation, preference
 * and i18n modules can share them without import cycles. English remains the
 * default regardless of host locale; every supported language is explicit.
 */

export const LANGUAGES = ["en", "es", "pt", "fr", "de", "it", "zh-CN", "ja", "ko", "ar"] as const;

export type Language = (typeof LANGUAGES)[number];

export type TextDirection = "ltr" | "rtl";

export interface LanguageMetadata {
  /** Canonical TPSTracer language identifier. */
  readonly value: Language;
  /** BCP 47 tag used only for Intl number formatting. */
  readonly tag: string;
  /** Native self-name shown in the language selector. */
  readonly nativeName: string;
  readonly dir: TextDirection;
  /** Localized fallback for a response without a known agent. */
  readonly unknownAgent: string;
}

/** Single source of truth for language support, Intl tags and native names. */
export const LANGUAGE_META: Record<Language, LanguageMetadata> = {
  en: { value: "en", tag: "en-US", nativeName: "English", dir: "ltr", unknownAgent: "Unknown" },
  es: { value: "es", tag: "es-ES", nativeName: "Español", dir: "ltr", unknownAgent: "Desconocido" },
  pt: { value: "pt", tag: "pt-BR", nativeName: "Português (Brasil)", dir: "ltr", unknownAgent: "Desconhecido" },
  fr: { value: "fr", tag: "fr-FR", nativeName: "Français", dir: "ltr", unknownAgent: "Inconnu" },
  de: { value: "de", tag: "de-DE", nativeName: "Deutsch", dir: "ltr", unknownAgent: "Unbekannt" },
  it: { value: "it", tag: "it-IT", nativeName: "Italiano", dir: "ltr", unknownAgent: "Sconosciuto" },
  "zh-CN": { value: "zh-CN", tag: "zh-CN", nativeName: "简体中文", dir: "ltr", unknownAgent: "未知" },
  ja: { value: "ja", tag: "ja-JP", nativeName: "日本語", dir: "ltr", unknownAgent: "不明" },
  ko: { value: "ko", tag: "ko-KR", nativeName: "한국어", dir: "ltr", unknownAgent: "알 수 없음" },
  ar: { value: "ar", tag: "ar-EG", nativeName: "العربية", dir: "rtl", unknownAgent: "غير معروف" },
};

export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function normalizeLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

/** Direction of the plugin-authored surface; unsupported values resolve to English. */
export function languageDirection(value: unknown): TextDirection {
  return LANGUAGE_META[normalizeLanguage(value)].dir;
}

/** Intl tag for the selected language; unsupported values resolve to en-US. */
export function localeTag(value: unknown): string {
  return LANGUAGE_META[normalizeLanguage(value)].tag;
}

/** Display-only bidi isolation direction: technical LTR or natural (auto). */
export type IsolationDirection = "ltr" | "auto";

/**
 * Wrap a display fragment in Unicode bidi isolates (LRI/PDI for technical
 * values, FSI/PDI for natural mixed-script values). Callers must use this only
 * on presentation strings; persisted/raw data is never mutated.
 */
export function bidiIsolate(value: string, direction: IsolationDirection): string {
  return direction === "ltr" ? `\u2066${value}\u2069` : `\u2068${value}\u2069`;
}

/**
 * Arabic-only interpolation policy. Non-Arabic output stays byte-identical;
 * Arabic isolates each embedded value so raw names/IDs cannot bleed into the
 * authored sentence. Do not pass an already-isolated fragment.
 */
export function isolateForLanguage(
  value: string,
  direction: IsolationDirection,
  lang: Language,
): string {
  return normalizeLanguage(lang) === "ar" ? bidiIsolate(value, direction) : value;
}

export const DEFAULT_LIVE_ESTIMATE = true;

/**
 * Resolve the persisted live-estimate preference. Missing, malformed or
 * pre-existing language-only values default to enabled; an explicit `false`
 * disables estimates without affecting final metrics or TTFT/activity.
 */
export function normalizeLiveEstimate(value: unknown): boolean {
  return value === false ? false : DEFAULT_LIVE_ESTIMATE;
}

/** Progressive dashboard detail. Simple is the entry experience. */
export type ViewMode = "simple" | "detailed";

export const DEFAULT_VIEW_MODE: ViewMode = "simple";

/**
 * Normalize a persisted or externally supplied view mode at a presentation
 * boundary. Anything other than the explicit detailed value is Simple, so a
 * legacy or malformed store can never hide the primary summary.
 */
export function normalizeViewMode(value: unknown): ViewMode {
  return value === "detailed" ? "detailed" : DEFAULT_VIEW_MODE;
}

/**
 * First-party diagnostic reasons as data, never as translated copy.
 * Views translate these at presentation time with the current language,
 * so already loaded snapshots retranslate immediately after a language
 * change. Unknown third-party details stay verbatim in `error` and are
 * shown under a localized wrapper; they never become a reason code.
 */
export type DiagnosticReason =
  | { readonly kind: "history-truncated"; readonly pages: number }
  | { readonly kind: "repeated-cursor" }
  | { readonly kind: "discovery-truncated"; readonly pages: number }
  | { readonly kind: "repeated-session-cursor" }
  | { readonly kind: "max-sessions"; readonly max: number }
  | { readonly kind: "discovery-cancelled" }
  | { readonly kind: "children-unreadable" }
  | { readonly kind: "discovery-failed" }
  | { readonly kind: "child-unavailable"; readonly sessionID: string }
  | { readonly kind: "partial-child" }
  | { readonly kind: "partial-root" }
  | { readonly kind: "session-incomplete" }
  | { readonly kind: "scope-incomplete" }
  | { readonly kind: "subagent-unavailable" }
  | { readonly kind: "unknown-error" };
