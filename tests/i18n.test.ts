import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  agentSelectionLabel,
  agentSelectionOf,
  ALL_AGENTS,
  nextPartialReason,
  resolveScope,
  rootScopeLabel,
  scopeDisplayName,
  scopeOptionsFor,
  type PartialReasonState,
} from "../src/presentation.js";
import {
  agentLabel,
  formatDuration,
  formatTokens,
  formatTps,
} from "../src/metrics.js";
import { SessionMetricsController } from "../src/adapter.js";
import { discoverDescendants, type ListSessionsPage } from "../src/tree.js";
import type {
  SessionMessageAssistant,
  SessionMessagesResponse,
  SessionInfo,
  SessionsResponse,
} from "@opencode/client/promise";
import type { FetchPage, TransportSeam } from "../src/transport.js";
import {
  catalogs,
  diagnosticText,
  LANGUAGE_OPTIONS,
  normalizeLanguage,
  placeholders,
  preferenceFromStoreValue,
  t,
  trendSummary,
} from "../src/i18n.js";
import type { DiagnosticReason } from "../src/definition.js";

function assistant(id: string): SessionMessageAssistant {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "acme", id: "fast" },
    content: [],
    tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, completed: 2000 },
    finish: "stop",
  };
}

function msgPage(ids: string[], next: string | null = null): SessionMessagesResponse {
  return { data: ids.map((id) => assistant(id)), cursor: { previous: null, next } };
}

function testSeam(fetchPage: FetchPage): TransportSeam {
  return {
    fetchPage,
    subscribe: () => () => {},
    isConnected: () => true,
    refs: { client: {}, data: {} },
  };
}

function sessionInfo(id: string, parentID?: string): SessionInfo {
  return {
    id,
    projectID: "proj",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/tmp" },
    ...(parentID !== undefined ? { parentID } : {}),
  } as SessionInfo;
}

describe("language preference default and fallback", () => {
  it("defaults to English and falls back on invalid/absent values", () => {
    expect(normalizeLanguage(undefined)).toBe("en");
    expect(normalizeLanguage(null)).toBe("en");
    expect(normalizeLanguage("")).toBe("en");
    expect(normalizeLanguage("fr")).toBe("fr");
    expect(normalizeLanguage("xx")).toBe("en");
    expect(normalizeLanguage("EN")).toBe("en");
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("es")).toBe("es");
  });

  it("resolves persisted store shapes without touching host locale", () => {
    expect(preferenceFromStoreValue(undefined)).toBe("en");
    expect(preferenceFromStoreValue(null)).toBe("en");
    expect(preferenceFromStoreValue({})).toBe("en");
    expect(preferenceFromStoreValue({ language: "es" })).toBe("es");
    expect(preferenceFromStoreValue({ language: "en" })).toBe("en");
    expect(preferenceFromStoreValue({ language: "fr" })).toBe("fr");
    expect(preferenceFromStoreValue({ language: "xx" })).toBe("en");
    expect(preferenceFromStoreValue("es")).toBe("es");
    expect(preferenceFromStoreValue("en")).toBe("en");
  });

  it("exposes native option labels and directions for all ten languages", () => {
    expect(LANGUAGE_OPTIONS.map((o) => o.value)).toEqual([
      "en",
      "es",
      "pt",
      "fr",
      "de",
      "it",
      "zh-CN",
      "ja",
      "ko",
      "ar",
    ]);
    expect(LANGUAGE_OPTIONS.map((o) => o.label)).toEqual([
      "English",
      "Español",
      "Português (Brasil)",
      "Français",
      "Deutsch",
      "Italiano",
      "简体中文",
      "日本語",
      "한국어",
      "العربية",
    ]);
    expect(LANGUAGE_OPTIONS.filter((o) => o.dir === "rtl").map((o) => o.value)).toEqual(["ar"]);
  });
});

describe("catalog parity and interpolation", () => {
  it("has matching keys in English and Spanish", () => {
    const enKeys = Object.keys(catalogs.en).sort();
    const esKeys = Object.keys(catalogs.es).sort();
    expect(esKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(50);
  });

  it("uses identical interpolation parameters per key", () => {
    for (const key of Object.keys(catalogs.en) as (keyof typeof catalogs.en)[]) {
      expect(placeholders(catalogs.es[key]!), `params for ${key}`).toEqual(
        placeholders(catalogs.en[key]!),
      );
    }
  });

  it("translates chrome and keeps brand untranslated", () => {
    expect(t("en", "toolbar.label")).toBe("Throughput");
    expect(t("es", "toolbar.label")).toBe("Rendimiento");
    expect(t("en", "panel.title")).toBe("TPSTracer");
    expect(t("es", "panel.title")).toBe("TPSTracer");
    expect(t("en", "command.open")).not.toBe(t("es", "command.open"));
    // Invalid language falls back to English.
    expect(t("xx" as "en", "toolbar.label")).toBe("Throughput");
  });

  it("names the session launcher TPSTracer in every language", () => {
    for (const lang of ["en", "es", "pt", "fr", "de", "it", "zh-CN", "ja", "ko", "ar"] as const) {
      expect(t(lang, "menu.open")).toBe("TPSTracer");
    }
    // The GUI definition duplicates the launcher catalog; keep both copies aligned.
    const gui = readFileSync(new URL("../src/gui.tsx", import.meta.url), "utf8");
    const menuEntries = gui.split("\n").filter((line) => line.includes('"menu.open":'));
    expect(menuEntries).toHaveLength(10);
    for (const line of menuEntries) expect(line).toContain('"menu.open": "TPSTracer"');
  });

  it("handles English singular/plural reasonably", () => {
    expect(trendSummary("en", 1, "10.0 tokens/s")).toMatch(/1 completed response; /);
    expect(trendSummary("en", 2, "10.0 tokens/s")).toMatch(/2 completed responses; /);
    expect(trendSummary("es", 1, "10,0 tokens/s")).toMatch(/1 respuesta completada; /);
    expect(t("en", "subagents.countOne", { count: 1 })).toBe("1 response");
    expect(t("en", "subagents.countOther", { count: 3 })).toBe("3 responses");
    expect(t("es", "subagents.countOne", { count: 1 })).toBe("1 respuesta");
    expect(t("es", "subagents.countOther", { count: 3 })).toBe("3 respuestas");
  });
});

describe("locale-aware formatting without changing calculations", () => {
  it("formats rates, counts and durations in en-US and es-ES", () => {
    expect(formatTps(50, "en")).toBe("50.0 tokens/s");
    expect(formatTps(50, "es")).toBe("50,0 tokens/s");
    expect(formatTps(1234.5, "en")).toContain(",");
    expect(formatTokens(1234, "en")).toBe("1,234");
    expect(formatTokens(1234, "es")).toBe("1234");
    expect(formatDuration(2000, "en")).toBe("2.0 s");
    expect(formatDuration(2000, "es")).toBe("2,0 s");
    // Unknown stays an em dash in both languages, never zero.
    expect(formatTokens(null, "en")).toBe("—");
    expect(formatTokens(null, "es")).toBe("—");
    expect(formatTps(null, "en")).toBe("—");
  });

  it("keeps unknown agents localized without renaming real agents", () => {
    expect(agentLabel("build", "en")).toBe("build");
    expect(agentLabel("build", "es")).toBe("build");
    expect(agentLabel(null, "en")).toBe("Unknown");
    expect(agentLabel(null, "es")).toBe("Desconocido");
    expect(agentSelectionLabel(ALL_AGENTS, "en")).toBe("All");
    expect(agentSelectionLabel(agentSelectionOf(null), "en")).toBe("Unknown");
  });

  it("labels scopes in both languages with identical session identity", () => {
    const tree = {
      rootSessionID: "root",
      children: [{ sessionID: "c1", title: null, agent: "plan", depth: 1 }],
    };
    const empty = { rootSessionID: "root", children: [] as typeof tree.children };
    expect(rootScopeLabel(0, "en")).toBe("Current session");
    expect(rootScopeLabel(1, "en")).toBe("Current session");
    expect(rootScopeLabel(2, "en")).toBe("Current session");
    expect(rootScopeLabel(0, "es")).toBe("Sesión actual");
    expect(rootScopeLabel(1, "es")).toBe("Sesión actual");
    expect(rootScopeLabel(2, "es")).toBe("Sesión actual");
    expect(scopeDisplayName(empty, "root", "en")).toBe("this session");
    expect(scopeDisplayName(tree, "root", "en")).toBe("this session");
    expect(scopeDisplayName(empty, "root", "es")).toBe("esta sesión");
    expect(scopeDisplayName(tree, "root", "es")).toBe("esta sesión");
    expect(resolveScope(tree, "c1", "en").label).toBe("the subagent plan");
    expect(resolveScope(tree, "c1", "es").label).toBe("el subagente plan");
    // Real task titles are never translated.
    const titled = {
      rootSessionID: "root",
      children: [{ sessionID: "c1", title: "Mi tarea", agent: "plan", depth: 1 }],
    };
    expect(scopeDisplayName(titled, "c1", "en")).toBe("«Mi tarea»");
    expect(scopeDisplayName(titled, "c1", "es")).toBe("«Mi tarea»");
    expect(scopeOptionsFor(titled, "en")[1]?.label).toBe("Mi tarea");
    // A real agent literally named Orchestrator keeps its name as data.
    expect(agentLabel("Orchestrator", "en")).toBe("Orchestrator");
    expect(agentLabel("Orchestrator", "es")).toBe("Orchestrator");
    expect(scopeDisplayName(
      { rootSessionID: "root", children: [{ sessionID: "c1", title: null, agent: "Orchestrator", depth: 1 }] },
      "c1",
      "en",
    )).toBe("the subagent Orchestrator");
  });
});

describe("header follow copy in both languages", () => {
  it("labels the working delegate and partial follow state without inventing agents", () => {
    expect(t("en", "header.workingDelegate", { identity: "plan" })).toBe("Working subagent plan");
    expect(t("es", "header.workingDelegate", { identity: "plan" })).toBe("Subagente en trabajo plan");
    expect(t("en", "header.partialNote", { reason: "a subagent is unavailable" })).toBe(
      "Partial follow view: a subagent is unavailable",
    );
    expect(t("es", "header.partialNote", { reason: "algún subagente no está disponible" })).toBe(
      "Vista parcial de seguimiento: algún subagente no está disponible",
    );
    // Titles stay verbatim data in either language.
    expect(t("en", "header.workingDelegate", { identity: "«Mi tarea»" })).toBe("Working subagent «Mi tarea»");
    expect(t("es", "header.workingDelegate", { identity: "«Mi tarea»" })).toBe("Subagente en trabajo «Mi tarea»");
  });
});

describe("first-party diagnostics at presentation time", () => {
  it("translates reason codes in both languages", () => {
    const truncated: DiagnosticReason = { kind: "history-truncated", pages: 2 };
    expect(diagnosticText(truncated, "en")).toMatch(/history truncated after 2 pages/);
    expect(diagnosticText(truncated, "es")).toMatch(/historial truncado tras 2 páginas/);
    const child: DiagnosticReason = { kind: "child-unavailable", sessionID: "c1" };
    expect(diagnosticText(child, "en")).toContain("c1");
    expect(diagnosticText(child, "es")).toContain("c1");
    // Session ids are data, never translated; only the wrapper changes.
    expect(diagnosticText(child, "en")).not.toBe(diagnosticText(child, "es"));
  });

  it("emits reason codes for truncated and repeated history", async () => {
    const looping = vi
      .fn()
      .mockResolvedValueOnce(msgPage(["a"], "loop"))
      .mockResolvedValue(msgPage(["b"], "loop"));
    const c = new SessionMetricsController({
      serverID: "s",
      sessionID: "s1",
      transport: testSeam(looping),
      debounceMs: 0,
    });
    await c.load();
    const state = c.getState();
    expect(state.status).toBe("partial");
    expect(state.reason).toEqual({ kind: "repeated-cursor" });
    expect(diagnosticText(state.reason!, "en")).toMatch(/repeated history cursor/);
    expect(diagnosticText(state.reason!, "es")).toMatch(/cursor de historial repetido/);
    c.dispose();

    let n = 0;
    const endless: FetchPage = async () => {
      n += 1;
      return msgPage([`m${n}`], `page-${n}`);
    };
    const capped = new SessionMetricsController({
      serverID: "s",
      sessionID: "s1",
      transport: testSeam(endless),
      safetyPageCap: 2,
      debounceMs: 0,
    });
    await capped.load();
    expect(capped.getState().status).toBe("partial");
    expect(capped.getState().reason).toEqual({ kind: "history-truncated", pages: 2 });
    capped.dispose();
  });

  it("emits reason codes for discovery limits and keeps verbatim third-party errors", async () => {
    const looping: ListSessionsPage = async () => ({
      data: [sessionInfo("a", "root")],
      cursor: { previous: null, next: "loop" },
    });
    const repeated = await discoverDescendants("root", looping);
    expect(repeated.partial).toBe(true);
    expect(repeated.errorReason).toEqual({ kind: "repeated-session-cursor" });

    const failList: ListSessionsPage = async ({ parentID }) => {
      throw new Error(`list failed for ${parentID}`);
    };
    const failed = await discoverDescendants(
      "root",
      async ({ parentID }) =>
        parentID === "bad"
          ? failList({ parentID, limit: 50 })
          : ({
              data: [sessionInfo("bad", "root"), sessionInfo("ok", "root")],
              cursor: { previous: null, next: null },
            }) as SessionsResponse,
    );
    expect(failed.partial).toBe(true);
    // Unknown third-party detail stays verbatim (contains the id), no invented code.
    expect(failed.error).toMatch(/bad/);
    expect(failed.errorReason).toBeNull();
  });

  it("retranslates already loaded data without storing prior-language copy", () => {
    const empty: PartialReasonState = { key: "", reason: null, verbatim: null };
    const live: DiagnosticReason = { kind: "history-truncated", pages: 3 };
    // Scope takes live data; refresh keeps it; language change only affects rendering.
    const taken = nextPartialReason(empty, "s1", live, null, false);
    const kept = nextPartialReason(taken, "s1", null, null, true);
    expect(kept).toBe(taken);
    expect(diagnosticText(kept.reason!, "en")).toMatch(/history truncated after 3 pages/);
    expect(diagnosticText(kept.reason!, "es")).toMatch(/historial truncado tras 3 páginas/);
    // Scope change never keeps another scope's data.
    expect(nextPartialReason(taken, "s2", null, null, true)).toEqual({
      key: "s2",
      reason: null,
      verbatim: null,
    });
  });
});
