/**
 * Typed ten-language catalogs and presentation-time helpers.
 *
 * English is the default regardless of host locale; every other supported
 * language is opt-in. Catalogs have matching keys and interpolation
 * parameters; unsupported or missing preferences resolve safely to English.
 * Numbers/durations are formatted with the selected Intl locale in metrics.ts;
 * this module owns copy and the selector metadata.
 */

import type { DiagnosticReason, Language, TextDirection, ViewMode } from "./definition.js";
import {
  DEFAULT_LANGUAGE,
  DEFAULT_VIEW_MODE,
  LANGUAGE_META,
  LANGUAGES,
  isolateForLanguage,
  localeTag as metadataLocaleTag,
  normalizeLanguage,
  normalizeLiveEstimate,
  normalizeViewMode,
} from "./definition.js";
import { ar } from "./locales/ar.js";
import { de } from "./locales/de.js";
import { fr } from "./locales/fr.js";
import { it } from "./locales/it.js";
import { ja } from "./locales/ja.js";
import { ko } from "./locales/ko.js";
import { pt } from "./locales/pt.js";
import { zhCN } from "./locales/zh-CN.js";
import { formatTokens } from "./metrics.js";

export type { Language, TextDirection } from "./definition.js";
export { DEFAULT_LANGUAGE, normalizeLanguage } from "./definition.js";

/** Resolve a persisted preference value to a language (fallback English). */
export function preferenceFromStoreValue(value: unknown): Language {
  if (typeof value === "string") return normalizeLanguage(value);
  if (value !== null && typeof value === "object") {
    const lang = (value as { language?: unknown }).language;
    return normalizeLanguage(lang);
  }
  return DEFAULT_LANGUAGE;
}

/** Resolve the persisted live-estimate flag; older language-only prefs stay enabled. */
export function liveEstimateFromStoreValue(value: unknown): boolean {
  if (typeof value === "boolean") return normalizeLiveEstimate(value);
  if (value !== null && typeof value === "object") {
    return normalizeLiveEstimate((value as { liveEstimate?: unknown }).liveEstimate);
  }
  return normalizeLiveEstimate(undefined);
}

/** Resolve the persisted view mode; missing or invalid values are Simple. */
export function viewModeFromStoreValue(value: unknown): ViewMode {
  if (typeof value === "string") return normalizeViewMode(value);
  if (value !== null && typeof value === "object") {
    return normalizeViewMode((value as { viewMode?: unknown }).viewMode);
  }
  return DEFAULT_VIEW_MODE;
}

export function localeTag(lang: Language): string {
  return metadataLocaleTag(lang);
}

export interface LanguageOption {
  readonly value: Language;
  readonly label: string;
  readonly dir: TextDirection;
}

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = LANGUAGES.map((value) => ({
  value,
  label: LANGUAGE_META[value].nativeName,
  dir: LANGUAGE_META[value].dir,
}));

const en = {
  "command.open": "Open TPSTracer throughput",
  "menu.open": "TPSTracer",
  "panel.title": "TPSTracer",
  "panel.scrollAria": "Scrollable TPSTracer panel",
  "toolbar.label": "Throughput",
  "toolbar.connected": "Connected",
  "toolbar.disconnected": "Disconnected",
  "toolbar.partial": "Partial",
  "view.modeLabel": "View mode",
  "view.simple": "Simple",
  "view.detailed": "Detailed",
  "menu.empty": "No options",
  "action.refresh": "Refresh",
  "action.refreshAria": "Refresh throughput",
  "action.retry": "Retry",
  "action.viewMetrics": "View metrics",
  "action.showMore": "Show more ({remaining} remaining)",
  "action.showMoreAgents": "Show more subagents ({remaining} remaining)",
  "language.label": "Language",
  "status.loading": "Loading throughput…",
  "status.empty": "No completed responses yet",
  "status.emptyDetail": "No completed responses yet. Metrics appear after the first finished response.",
  "status.disconnected": "Server disconnected",
  "status.disconnectedDetail": "Server disconnected. History reloads automatically on reconnect.",
  "status.partial": "Partial history: {reason}",
  "status.partialNote": "Partial history: {reason}. Values are not session totals.",
  "status.error": "Throughput unavailable: {reason}",
  "status.idle": "Throughput unavailable",
  "status.idleDetail": "Throughput unavailable.",
  "status.readySession": "{last} · session {weighted}",
  "header.openHint": "Activate to open the throughput panel.",
  "header.workingDelegate": "Working subagent {identity}",
  "header.partialNote": "Partial follow view: {reason}",
  "header.latestRefreshing": "Latest completed measurement {rate} · updating…",
  "header.latestUnmeasuredRefreshing": "Latest completed response unmeasured · updating…",
  "header.liveEstimate": "Estimated live {rate}",
  "header.finalContext": "Last completed response {rate}",
  "header.ttftShort": "TTFT {duration}",
  "header.waitingLabel": "Waiting for output",
  "live.short": "live",
  "live.shortWaiting": "waiting",
  "live.shortStreaming": "receiving",
  "live.shortTool": "tool",
  "live.shortTools": "{count} tools",
  "live.shortRetry": "retry",
  "live.shortSettling": "finalizing",
  "live.waiting": "Waiting for output",
  "live.streaming": "Receiving output",
  "live.tool": "Tool running",
  "live.tools": "{count} tools running",
  "live.retry": "Retrying",
  "live.settling": "Finishing",
  "live.idle": "No active step",
  "live.activityLabel": "Activity",
  "live.estimateLabel": "Live estimate",
  "live.ttftLabel": "TTFT",
  "live.estimateOff": "Live estimate off",
  "live.approxNote":
    "Estimated from observed visible output at four characters per token; not provider tokens or hidden reasoning. Final metrics are unaffected.",
  "live.approxShort": "Approximate from visible output; final metrics are unaffected.",
  "live.toggle": "Live estimate",
  "live.rowAria": "Live activity and time to first token",
  "live.sessionScope": "Session · {scope}",
  "live.elapsed": "Elapsed {duration}",
  "live.elapsedUnknown": "Elapsed unknown",
  "live.finalContext": "Last final {rate}",
  "live.ttftObserved": "{duration} observed",
  "live.ttftUnknown": "Not observed",
  "hero.last": "Latest response",
  "hero.weighted": "Weighted average",
  "hero.scope": "Only {scope}",
  "hero.secondary": "Wall-clock {rate}",
  "hero.coverage": "Active {measured} of {total} responses",
  "simple.aria": "Simple session summary",
  "simple.lastHint": "Newest completed response in {scope}.",
  "simple.weightedHint":
    "Output + reasoning ÷ provider-active time across {scope}; not an average of rates.",
  "simple.lastUnavailable": "No measured rate for the newest completed response.",
  "simple.weightedUnavailable": "No measured provider-active responses yet.",
  "simple.explanation":
    "Final speeds use output + reasoning over provider-active time and are independent of the approximate live estimate.",
  "rate.primary": "Provider-active",
  "rate.secondary": "Wall-clock",
  "rate.generated": "Generated tokens (output + reasoning)",
  "trend.empty": "No completed responses for the trend.",
  "trend.fallback": "No trend yet: it appears with completed responses.",
  "trend.hint": "Last {max} completed responses, in chronological order. Gaps are unmeasured responses.",
  "trend.title": "Provider-active generated tokens/s",
  "trend.description":
    "Per completed response: output + reasoning ÷ provider-active time. Oldest response on the left, newest on the right.",
  "trend.legend": "Measured provider-active rate",
  "trend.unit": "tokens/s",
  "trend.axisX": "Response order",
  "trend.axisOlder": "older",
  "trend.axisNewer": "newer",
  "trend.allZero": "All measured responses in this window are 0 tokens/s.",
  "trend.unmeasured":
    "Completed responses in this window have no measured provider-active rate. Missing values are not plotted as zero.",
  "trend.gap": "gap",
  "trend.aria": "Throughput trend of the last {count} responses. {summary}",
  "trend.summaryOne": "{count} completed response; peak {peak}.",
  "trend.summaryOther": "{count} completed responses; peak {peak}.",
  "history.caption": "Response history, newest first",
  "history.model": "Model",
  "history.speed": "Speed · active",
  "history.speedWall": "Speed · wall",
  "history.output": "Output",
  "history.reasoning": "Reasoning",
  "history.duration": "Duration",
  "history.active": "Active",
  "history.total": "Total",
  "about.summary": "About these metrics",
  "about.body":
    "Primary provider-active speed = generated tokens (output + reasoning) ÷ provider-active seconds (streamed − created). Streamed marks the end of the provider stream before post-stream local-tool waiting, not first-token time; it still includes request latency/prefill and possible in-stream delays, so this is not pure decode speed or TTFT. Secondary wall-clock speed = output ÷ total seconds (completed − created) and is shown separately, never as a hidden fallback. Averages weight paired tokens and durations; they never average speeds nor sum parallel work across agents: each scope shows only its own responses. Formulas match CLI per-step ingredients, not CLI full-turn grouping (assistant-only history lacks turn boundaries).",
  "about.live":
    "Live estimates use observed visible text, reasoning and tool-input characters in a trailing 3-second window at about four characters per token. Language and content bias the character-to-token ratio (CJK, code and prose differ), and buffered transport can delay or bunch arrivals. The live rate divides observed arrivals by observed time including silence; the final provider-active rate divides output + reasoning by streamed − created. Live estimates never feed final metrics, and hidden reasoning is never inferred.",
  "partial.details": "Partial view: activate to read details",
  "partial.treeNote":
    "Partial view: {reason}. Each scope shows only its own responses; there are no tree totals.",
  "partial.scopeNote": "Partial history in {scope}: {reason}. Values are not scope totals.",
  "panel.ariaSession": "TPSTracer session throughput",
  "panel.ariaTree": "TPSTracer throughput by agents",
  "totals.ariaSession": "Session totals",
  "totals.ariaScope": "Totals for {scope}",
  "totals.output": "Output",
  "totals.reasoning": "Reasoning",
  "totals.responses": "Responses",
  "totals.generated": "Generated",
  "totals.failed": "Failed",
  "totals.unfinished": "Unfinished",
  "section.trend": "Trend",
  "section.trendScope": "Trend · {scope}",
  "section.trendAria": "Throughput trend",
  "section.history": "History",
  "section.historyScope": "History · {scope}",
  "section.historyAria": "Response history",
  "section.historyScopeAria": "History of {scope}",
  "section.agents": "By agent",
  "section.agentsAria": "Filter by agent",
  "section.agentsGroup": "Filter history by agent",
  "section.models": "Models",
  "section.modelsScope": "Models · all loaded sessions",
  "section.modelsAria": "Model overview across loaded sessions",
  "scope.label": "Session",
  "scope.current": "Current session",
  "scope.thisSession": "this session",
  "scope.selected": "Selected session",
  "scope.child": "Subagent · level {depth}",
  "scope.loading": "Loading {scope}…",
  "scope.empty": "No completed responses yet in {scope}. Metrics appear after the first finished response.",
  "scope.error": "{scope}: throughput unavailable ({reason}). Other scopes remain available in the selector.",
  "scope.childName": "the subagent {agent}",
  "agent.all": "All",
  "agent.unknown": "Unknown",
  "agent.withTitle": "Agent {label}",
  "agent.unknownFull": "Unknown agent (not invented)",
  "agent.unknownShort": "(unknown, not invented)",
  "agent.noKnown": "Responses with no known agent",
  "agent.from": "Responses from agent {agent}",
  "subagents.title": "Subagents ({count})",
  "subagents.aria": "Subagents",
  "subagents.partial": " · partial view",
  "subagents.level": "Level {depth}",
  "subagents.unavailable": "unavailable",
  "subagents.noResponses": "no responses",
  "subagents.disconnected": "disconnected",
  "subagents.loading": "loading…",
  "subagents.countOne": "{count} response",
  "subagents.countOther": "{count} responses",
  "subagents.model": "Model ",
  "subagents.latest": "Latest {rate}",
  "subagents.average": "Average {rate}",
  "subagents.outputReasoning": "{output} output · {reasoning} reasoning",
  "subagents.unavailableDetail": "Unavailable: {reason}",
  "subagents.disconnectedDetail": "Disconnected",
  "subagents.emptyDetail": "No completed responses",
  "subagents.loadingDetail": "Loading…",
  "models.hint": "Every provider/model pair across loaded sessions, independent of the selected scope. Pooled rates are per-request performance, not system throughput.",
  "models.empty": "No models observed yet",
  "models.loading": "Loading models…",
  "models.measuredUsage": "Measured usage",
  "models.showMore": "Show more models ({remaining} remaining)",
  "models.observed": "{count} observed",
  "models.measured": "{measured} of {observed} measured",
  "models.unmeasured": "unmeasured",
  "models.sessions": "Sessions {count}",
  "models.partialNote": "Partial model view: some sessions are incomplete or unavailable.",
  "models.activeRate": "Active {rate}",
  "models.wallRate": "Wall {rate}",
  "diag.historyTruncated": "history truncated after {pages} pages; session total incomplete",
  "diag.repeatedCursor": "repeated history cursor; session total incomplete",
  "diag.discoveryTruncated": "discovery truncated after {pages} pages",
  "diag.repeatedSessionCursor": "repeated session cursor; tree incomplete",
  "diag.maxSessions": "child session limit of {max} reached",
  "diag.discoveryCancelled": "discovery cancelled",
  "diag.childrenUnreadable": "could not read child sessions",
  "diag.discoveryFailed": "could not discover subagents",
  "diag.childUnavailable": "subagent {sessionID} unavailable",
  "diag.partialChild": "partial history in a subagent",
  "diag.partialRoot": "partial history in the current session",
  "diag.sessionIncomplete": "incomplete session total",
  "diag.scopeIncomplete": "incomplete total",
  "diag.subagentUnavailable": "a subagent is unavailable",
  "diag.unknownError": "unknown error",
} as const;

export type MessageKey = keyof typeof en;

export const es: Record<MessageKey, string> = {
  "command.open": "Abrir rendimiento TPSTracer",
  "menu.open": "TPSTracer",
  "panel.title": "TPSTracer",
  "panel.scrollAria": "Panel desplazable de TPSTracer",
  "toolbar.label": "Rendimiento",
  "toolbar.connected": "Conectado",
  "toolbar.disconnected": "Desconectado",
  "toolbar.partial": "Parcial",
  "view.modeLabel": "Modo de vista",
  "view.simple": "Simple",
  "view.detailed": "Detallada",
  "menu.empty": "Sin opciones",
  "action.refresh": "Actualizar",
  "action.refreshAria": "Actualizar rendimiento",
  "action.retry": "Reintentar",
  "action.viewMetrics": "Ver métricas",
  "action.showMore": "Ver más ({remaining} restantes)",
  "action.showMoreAgents": "Ver más subagentes ({remaining} restantes)",
  "language.label": "Idioma",
  "status.loading": "Cargando rendimiento…",
  "status.empty": "Sin respuestas completadas todavía",
  "status.emptyDetail": "Sin respuestas completadas todavía. Las métricas aparecen tras la primera respuesta terminada.",
  "status.disconnected": "Servidor desconectado",
  "status.disconnectedDetail": "Servidor desconectado. El historial se recarga solo al reconectar.",
  "status.partial": "Historial parcial: {reason}",
  "status.partialNote": "Historial parcial: {reason}. Los valores no son totales de la sesión.",
  "status.error": "Rendimiento no disponible: {reason}",
  "status.idle": "Rendimiento no disponible",
  "status.idleDetail": "Rendimiento no disponible.",
  "status.readySession": "{last} · sesión {weighted}",
  "header.openHint": "Activar para abrir el panel de rendimiento.",
  "header.workingDelegate": "Subagente en trabajo {identity}",
  "header.partialNote": "Vista parcial de seguimiento: {reason}",
  "header.latestRefreshing": "Última medición completada {rate} · actualizando…",
  "header.latestUnmeasuredRefreshing": "Última respuesta completada sin medición · actualizando…",
  "header.liveEstimate": "En vivo estimado {rate}",
  "header.finalContext": "Última respuesta completada {rate}",
  "header.ttftShort": "TTFT {duration}",
  "header.waitingLabel": "Esperando salida",
  "live.short": "en vivo",
  "live.shortWaiting": "esperando",
  "live.shortStreaming": "recibiendo",
  "live.shortTool": "herramienta",
  "live.shortTools": "{count} herramientas",
  "live.shortRetry": "reintento",
  "live.shortSettling": "finalizando",
  "live.waiting": "Esperando salida",
  "live.streaming": "Recibiendo salida",
  "live.tool": "Herramienta en ejecución",
  "live.tools": "{count} herramientas en ejecución",
  "live.retry": "Reintentando",
  "live.settling": "Finalizando",
  "live.idle": "Sin paso activo",
  "live.activityLabel": "Actividad",
  "live.estimateLabel": "Estimación en vivo",
  "live.ttftLabel": "TTFT",
  "live.estimateOff": "Estimación en vivo desactivada",
  "live.approxNote":
    "Estimado a partir de la salida visible observada a cuatro caracteres por token; no son tokens del proveedor ni razonamiento oculto. Las métricas finales no cambian.",
  "live.approxShort": "Aproximado a partir de la salida visible; las métricas finales no cambian.",
  "live.toggle": "Estimación en vivo",
  "live.rowAria": "Actividad en vivo y tiempo hasta el primer token",
  "live.sessionScope": "Sesión · {scope}",
  "live.elapsed": "Transcurrido {duration}",
  "live.elapsedUnknown": "Transcurrido desconocido",
  "live.finalContext": "Último valor final {rate}",
  "live.ttftObserved": "{duration} observado",
  "live.ttftUnknown": "Sin observar",
  "hero.last": "Última respuesta",
  "hero.weighted": "Promedio ponderado",
  "hero.scope": "Solo {scope}",
  "hero.secondary": "Reloj total {rate}",
  "hero.coverage": "Activas {measured} de {total} respuestas",
  "simple.aria": "Resumen simple de la sesión",
  "simple.lastHint": "Última respuesta completada de {scope}.",
  "simple.weightedHint":
    "Salida + razonamiento ÷ tiempo proveedor-activo de {scope}; no es un promedio de velocidades.",
  "simple.lastUnavailable": "Sin medición para la última respuesta completada.",
  "simple.weightedUnavailable": "Aún no hay respuestas proveedor-activas medidas.",
  "simple.explanation":
    "Las velocidades finales usan salida + razonamiento sobre tiempo proveedor-activo y no dependen de la estimación en vivo aproximada.",
  "rate.primary": "Proveedor-activo",
  "rate.secondary": "Reloj total",
  "rate.generated": "Tokens generados (salida + razonamiento)",
  "trend.empty": "Sin respuestas completadas para la tendencia.",
  "trend.fallback": "Sin tendencia todavía: aparece con las respuestas completadas.",
  "trend.hint": "Últimas {max} respuestas completadas, en orden cronológico. Los huecos son respuestas sin medición.",
  "trend.title": "Velocidad proveedor-activa (tokens generados/s)",
  "trend.description":
    "Por respuesta completada: salida + razonamiento ÷ tiempo proveedor-activo. La respuesta más antigua a la izquierda y la más reciente a la derecha.",
  "trend.legend": "Velocidad proveedor-activa medida",
  "trend.unit": "tokens/s",
  "trend.axisX": "Orden de respuestas",
  "trend.axisOlder": "más antigua",
  "trend.axisNewer": "más reciente",
  "trend.allZero": "Todas las respuestas medidas de esta ventana son 0 tokens/s.",
  "trend.unmeasured":
    "Las respuestas completadas de esta ventana no tienen velocidad proveedor-activa medida. Los valores ausentes no se dibujan como cero.",
  "trend.gap": "hueco",
  "trend.aria": "Tendencia de velocidad de las últimas {count} respuestas. {summary}",
  "trend.summaryOne": "{count} respuesta completada; máximo {peak}.",
  "trend.summaryOther": "{count} respuestas completadas; máximo {peak}.",
  "history.caption": "Historial de respuestas, las más recientes primero",
  "history.model": "Modelo",
  "history.speed": "Velocidad · activa",
  "history.speedWall": "Velocidad · total",
  "history.output": "Salida",
  "history.reasoning": "Razonamiento",
  "history.duration": "Duración",
  "history.active": "Activa",
  "history.total": "Total",
  "about.summary": "Acerca de estas métricas",
  "about.body":
    "Velocidad principal proveedor-activa = tokens generados (salida + razonamiento) ÷ segundos proveedor-activos (streamed − created). Streamed marca el fin del flujo del proveedor antes de la espera local de herramientas, no el primer token; aún incluye latencia de solicitud/prefill y posibles demoras en el flujo, así que no es velocidad pura de decodificación ni TTFT. Velocidad secundaria de reloj total = salida ÷ segundos totales (completed − created) y se muestra por separado, nunca como reemplazo oculto. Los promedios ponderan tokens y duraciones emparejados; nunca promedian velocidades ni suman el trabajo paralelo de varios agentes: cada ámbito muestra solo sus propias respuestas. Las fórmulas coinciden con los ingredientes por paso de la CLI, no con la agrupación por turnos de la CLI (el historial solo-asistente no tiene límites de turno).",
  "about.live":
    "Las estimaciones en vivo usan caracteres observados de texto, razonamiento y entrada de herramientas en una ventana móvil de 3 segundos, a unos cuatro caracteres por token. El idioma y el contenido sesgan la proporción carácter-token (CJK, código y prosa difieren), y un transporte con búfer puede retrasar o agrupar llegadas. La tasa en vivo divide las llegadas observadas entre el tiempo observado, incluido el silencio; la tasa final proveedor-activa divide salida + razonamiento entre streamed − created. Las estimaciones en vivo nunca alimentan las métricas finales y el razonamiento oculto nunca se infiere.",
  "partial.details": "Vista parcial: activar para leer el detalle",
  "partial.treeNote":
    "Vista parcial: {reason}. Cada ámbito muestra solo sus propias respuestas; no hay totales del árbol.",
  "partial.scopeNote": "Historial parcial en {scope}: {reason}. Los valores no son totales del ámbito.",
  "panel.ariaSession": "Rendimiento de la sesión TPSTracer",
  "panel.ariaTree": "Rendimiento TPSTracer por agentes",
  "totals.ariaSession": "Totales de la sesión",
  "totals.ariaScope": "Totales de {scope}",
  "totals.output": "Salida",
  "totals.reasoning": "Razonamiento",
  "totals.responses": "Respuestas",
  "totals.generated": "Generados",
  "totals.failed": "Fallidas",
  "totals.unfinished": "Sin terminar",
  "section.trend": "Tendencia",
  "section.trendScope": "Tendencia · {scope}",
  "section.trendAria": "Tendencia de velocidad",
  "section.history": "Historial",
  "section.historyScope": "Historial · {scope}",
  "section.historyAria": "Historial de respuestas",
  "section.historyScopeAria": "Historial de {scope}",
  "section.agents": "Por agente",
  "section.agentsAria": "Filtrar por agente",
  "section.agentsGroup": "Filtrar historial por agente",
  "section.models": "Modelos",
  "section.modelsScope": "Modelos · todas las sesiones cargadas",
  "section.modelsAria": "Resumen de modelos en sesiones cargadas",
  "scope.label": "Sesión",
  "scope.current": "Sesión actual",
  "scope.thisSession": "esta sesión",
  "scope.selected": "Sesión seleccionada",
  "scope.child": "Subagente · nivel {depth}",
  "scope.loading": "Cargando {scope}…",
  "scope.empty": "Sin respuestas completadas todavía en {scope}. Las métricas aparecen tras la primera respuesta terminada.",
  "scope.error": "{scope}: rendimiento no disponible ({reason}). Los demás ámbitos siguen disponibles en el selector.",
  "scope.childName": "el subagente {agent}",
  "agent.all": "Todos",
  "agent.unknown": "Desconocido",
  "agent.withTitle": "Agente {label}",
  "agent.unknownFull": "Agente desconocido (no inventado)",
  "agent.unknownShort": "(desconocido, no inventado)",
  "agent.noKnown": "Respuestas sin agente conocido",
  "agent.from": "Respuestas del agente {agent}",
  "subagents.title": "Subagentes ({count})",
  "subagents.aria": "Subagentes",
  "subagents.partial": " · vista parcial",
  "subagents.level": "Nivel {depth}",
  "subagents.unavailable": "no disponible",
  "subagents.noResponses": "sin respuestas",
  "subagents.disconnected": "desconectado",
  "subagents.loading": "cargando…",
  "subagents.countOne": "{count} respuesta",
  "subagents.countOther": "{count} respuestas",
  "subagents.model": "Modelo ",
  "subagents.latest": "Última {rate}",
  "subagents.average": "Media {rate}",
  "subagents.outputReasoning": "{output} salida · {reasoning} razonamiento",
  "subagents.unavailableDetail": "No disponible: {reason}",
  "subagents.disconnectedDetail": "Desconectado",
  "subagents.emptyDetail": "Sin respuestas completadas",
  "subagents.loadingDetail": "Cargando…",
  "models.hint": "Cada par proveedor/modelo en las sesiones cargadas, sin depender del ámbito seleccionado. Las tasas agrupadas son rendimiento por solicitud, no caudal del sistema.",
  "models.empty": "Sin modelos observados todavía",
  "models.loading": "Cargando modelos…",
  "models.measuredUsage": "Uso medido",
  "models.showMore": "Ver más modelos ({remaining} restantes)",
  "models.observed": "{count} observados",
  "models.measured": "{measured} de {observed} medidos",
  "models.unmeasured": "sin medir",
  "models.sessions": "Sesiones {count}",
  "models.partialNote": "Vista parcial de modelos: algunas sesiones están incompletas o no disponibles.",
  "models.activeRate": "Activa {rate}",
  "models.wallRate": "Total {rate}",
  "diag.historyTruncated": "historial truncado tras {pages} páginas; total de sesión incompleto",
  "diag.repeatedCursor": "cursor de historial repetido; total de sesión incompleto",
  "diag.discoveryTruncated": "descubrimiento truncado tras {pages} páginas",
  "diag.repeatedSessionCursor": "cursor de sesiones repetido; árbol incompleto",
  "diag.maxSessions": "límite de {max} sesiones hijas alcanzado",
  "diag.discoveryCancelled": "descubrimiento cancelado",
  "diag.childrenUnreadable": "no se pudo leer sesiones hijas",
  "diag.discoveryFailed": "no se pudo descubrir subagentes",
  "diag.childUnavailable": "subagente {sessionID} no disponible",
  "diag.partialChild": "historial parcial en un subagente",
  "diag.partialRoot": "historial parcial en la sesión actual",
  "diag.sessionIncomplete": "total de sesión incompleto",
  "diag.scopeIncomplete": "total incompleto",
  "diag.subagentUnavailable": "algún subagente no está disponible",
  "diag.unknownError": "error desconocido",
};

export const catalogs: Record<Language, Record<MessageKey, string>> = {
  en,
  es,
  pt,
  fr,
  de,
  it,
  "zh-CN": zhCN,
  ja,
  ko,
  ar,
};

export type Params = Record<string, string | number>;

function render(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m,
  );
}

/** Translate a catalog key with the current language (fallback English). */
export function t(lang: Language, key: MessageKey, params?: Params): string {
  const l = normalizeLanguage(lang);
  const template = catalogs[l][key] ?? en[key];
  return render(template, params);
}

/** Placeholders (`{name}`) inside a template, for parity checks. */
export function placeholders(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(/\{(\w+)\}/g)) out.add(m[1]!);
  return [...out].sort();
}

export function trendSummary(lang: Language, count: number, peak: string): string {
  const l = normalizeLanguage(lang);
  const key = count === 1 ? "trend.summaryOne" : "trend.summaryOther";
  return t(l, key, {
    count: isolateForLanguage(formatTokens(count, l), "ltr", l),
    peak: isolateForLanguage(peak, "ltr", l),
  });
}

/** Presentation-time translation of a first-party reason code. */
export function diagnosticText(reason: DiagnosticReason, lang: Language): string {
  const l = normalizeLanguage(lang);
  switch (reason.kind) {
    case "history-truncated":
      return t(l, "diag.historyTruncated", {
        pages: isolateForLanguage(formatTokens(reason.pages, l), "ltr", l),
      });
    case "repeated-cursor":
      return t(l, "diag.repeatedCursor");
    case "discovery-truncated":
      return t(l, "diag.discoveryTruncated", {
        pages: isolateForLanguage(formatTokens(reason.pages, l), "ltr", l),
      });
    case "repeated-session-cursor":
      return t(l, "diag.repeatedSessionCursor");
    case "max-sessions":
      return t(l, "diag.maxSessions", {
        max: isolateForLanguage(formatTokens(reason.max, l), "ltr", l),
      });
    case "discovery-cancelled":
      return t(l, "diag.discoveryCancelled");
    case "children-unreadable":
      return t(l, "diag.childrenUnreadable");
    case "discovery-failed":
      return t(l, "diag.discoveryFailed");
    case "child-unavailable":
      return t(l, "diag.childUnavailable", {
        sessionID: isolateForLanguage(reason.sessionID, "auto", l),
      });
    case "partial-child":
      return t(l, "diag.partialChild");
    case "partial-root":
      return t(l, "diag.partialRoot");
    case "session-incomplete":
      return t(l, "diag.sessionIncomplete");
    case "scope-incomplete":
      return t(l, "diag.scopeIncomplete");
    case "subagent-unavailable":
      return t(l, "diag.subagentUnavailable");
    case "unknown-error":
    default:
      return t(l, "diag.unknownError");
  }
}
