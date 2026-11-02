import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bidiIsolate,
  isolateForLanguage,
  LANGUAGES,
  LANGUAGE_META,
  languageDirection,
  localeTag,
  normalizeLanguage,
} from "../src/definition.js";
import {
  catalogs,
  diagnosticText,
  LANGUAGE_OPTIONS,
  placeholders,
  preferenceFromStoreValue,
  t,
  trendSummary,
  type MessageKey,
} from "../src/i18n.js";
import { agentLabel, formatDuration, formatTokens, formatTps } from "../src/metrics.js";
import {
  formatTtft,
  headerProvenance,
  liveRowPresentation,
  modelStatusNote,
  scopeDisplayName,
  scopeOptionsFor,
} from "../src/presentation.js";
import type { LiveScopeSnapshot } from "../src/live.js";
import { trendPointX, trendPointY, TREND_Y_BOTTOM, TREND_Y_TOP } from "../src/dashboard.js";

const nonEnglish = LANGUAGES.filter((lang) => lang !== "en");

function rateFormat(lang: (typeof LANGUAGES)[number]): Intl.NumberFormat {
  return new Intl.NumberFormat(LANGUAGE_META[lang].tag, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function intFormat(lang: (typeof LANGUAGES)[number]): Intl.NumberFormat {
  return new Intl.NumberFormat(LANGUAGE_META[lang].tag, { maximumFractionDigits: 0 });
}

describe("language metadata and normalization", () => {
  it("declares all ten canonical identifiers, locale tags and native names", () => {
    expect([...LANGUAGES]).toEqual(["en", "es", "pt", "fr", "de", "it", "zh-CN", "ja", "ko", "ar"]);
    expect(LANGUAGES.map((lang) => LANGUAGE_META[lang].tag)).toEqual([
      "en-US",
      "es-ES",
      "pt-BR",
      "fr-FR",
      "de-DE",
      "it-IT",
      "zh-CN",
      "ja-JP",
      "ko-KR",
      "ar-EG",
    ]);
    expect(LANGUAGES.map((lang) => LANGUAGE_META[lang].nativeName)).toEqual([
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
    expect(LANGUAGES.map((lang) => localeTag(lang))).toEqual(
      LANGUAGES.map((lang) => LANGUAGE_META[lang].tag),
    );
  });

  it("accepts every supported value and falls back to English for unsupported data", () => {
    for (const lang of LANGUAGES) {
      expect(normalizeLanguage(lang)).toBe(lang);
      expect(preferenceFromStoreValue(lang)).toBe(lang);
      expect(preferenceFromStoreValue({ language: lang })).toBe(lang);
    }
    expect(normalizeLanguage("EN")).toBe("en");
    expect(normalizeLanguage("pt-BR")).toBe("en");
    expect(normalizeLanguage("xx")).toBe("en");
    expect(preferenceFromStoreValue({ language: "xx" })).toBe("en");
    expect(t("xx" as "en", "toolbar.label")).toBe("Throughput");
  });

  it("keeps Arabic RTL and every other supported language LTR", () => {
    expect(languageDirection("ar")).toBe("rtl");
    expect(languageDirection("en")).toBe("ltr");
    for (const lang of LANGUAGES.filter((value) => value !== "ar")) {
      expect(languageDirection(lang)).toBe("ltr");
    }
    expect(languageDirection("xx")).toBe("ltr");
    expect(LANGUAGE_OPTIONS.filter((option) => option.dir === "rtl").map((option) => option.value)).toEqual([
      "ar",
    ]);
  });
});

describe("complete ten-language catalogs", () => {
  it("keeps exact key and placeholder parity for every locale", () => {
    const enKeys = Object.keys(catalogs.en).sort();
    expect(enKeys).toHaveLength(196);
    for (const lang of LANGUAGES) {
      expect(Object.keys(catalogs[lang]).sort(), `keys for ${lang}`).toEqual(enKeys);
      for (const key of enKeys as MessageKey[]) {
        expect(placeholders(catalogs[lang][key]), `${lang} params for ${key}`).toEqual(
          placeholders(catalogs.en[key]),
        );
      }
    }
    expect(Object.keys(catalogs)).toEqual([...LANGUAGES]);
  });

  it("keeps brand, technical units and TTFT invariant", () => {
    for (const lang of LANGUAGES) {
      expect(t(lang, "menu.open")).toBe("TPSTracer");
      expect(t(lang, "panel.title")).toBe("TPSTracer");
      expect(t(lang, "trend.unit")).toBe("tokens/s");
      expect(t(lang, "live.ttftLabel")).toBe("TTFT");
      expect(t(lang, "header.ttftShort")).toBe("TTFT {duration}");
    }
  });

  it("translates representative prose instead of spreading English", () => {
    const keys: readonly MessageKey[] = [
      "command.open",
      "toolbar.label",
      "status.loading",
      "about.summary",
      "history.model",
      "scope.current",
      "agent.unknown",
      "diag.unknownError",
    ];
    for (const lang of nonEnglish) {
      for (const key of keys) {
        expect(t(lang, key), `${lang} ${key}`).not.toBe(t("en", key));
      }
    }
  });

  it("uses reviewed native copy including Portuguese, French and Spanish accents", () => {
    expect(t("es", "scope.current")).toBe("Sesión actual");
    expect(t("es", "status.empty")).toBe("Sin respuestas completadas todavía");
    expect(t("pt", "toolbar.label")).toBe("Vazão");
    expect(t("pt", "language.label")).toBe("Idioma");
    expect(t("pt", "scope.current")).toBe("Sessão atual");
    expect(t("pt", "status.empty")).toBe("Nenhuma resposta concluída ainda");
    expect(t("fr", "language.label")).toBe("Langue");
    expect(t("fr", "scope.current")).toBe("Session actuelle");
    expect(t("fr", "status.empty")).toBe("Aucune réponse terminée pour l'instant");
    expect(t("de", "language.label")).toBe("Sprache");
    expect(t("de", "scope.current")).toBe("Aktuelle Sitzung");
    expect(t("de", "status.empty")).toBe("Noch keine abgeschlossenen Antworten");
    expect(t("it", "language.label")).toBe("Lingua");
    expect(t("it", "scope.current")).toBe("Sessione corrente");
    expect(t("zh-CN", "language.label")).toBe("语言");
    expect(t("zh-CN", "scope.current")).toBe("当前会话");
    expect(t("ja", "language.label")).toBe("言語");
    expect(t("ja", "scope.current")).toBe("現在のセッション");
    expect(t("ko", "language.label")).toBe("언어");
    expect(t("ko", "scope.current")).toBe("현재 세션");
    expect(t("ar", "language.label")).toBe("اللغة");
    expect(t("ar", "scope.current")).toBe("الجلسة الحالية");
    expect(t("ar", "menu.open")).toBe("TPSTracer");
  });

  it("preserves the technical meaning of streamed, final TPS, live estimates and averages", () => {
    for (const lang of LANGUAGES) {
      const about = t(lang, "about.body");
      expect(about, `${lang} streamed`).toContain("streamed");
      expect(about, `${lang} created`).toContain("created");
      expect(about, `${lang} completed`).toContain("completed");
      expect(about, `${lang} TTFT caveat`).toContain("TTFT");
      const live = t(lang, "about.live");
      expect(live, `${lang} live streamed`).toContain("streamed");
      expect(live, `${lang} live created`).toContain("created");
      expect(live, `${lang} live window`).toContain("3");
      expect(t(lang, "live.approxNote").length, `${lang} live note`).toBeGreaterThan(40);
      expect(t(lang, "simple.weightedHint").length, `${lang} weighted hint`).toBeGreaterThan(20);
    }
  });

  it("translates first-party diagnostics while preserving session ids", () => {
    const truncated = { kind: "history-truncated", pages: 2 } as const;
    const child = { kind: "child-unavailable", sessionID: "session-α" } as const;
    for (const lang of nonEnglish) {
      expect(diagnosticText(truncated, lang)).not.toBe(diagnosticText(truncated, "en"));
    }
    for (const lang of LANGUAGES) {
      expect(diagnosticText(child, lang)).toContain("session-α");
    }
  });
});

describe("actual preference schema decoding", () => {
  it("decodes every new language plus legacy and default stores", () => {
    const script = [
      'import { Schema } from "effect";',
      'import { PrefsSchema } from "./src/prefs.ts";',
      `const langs = ${JSON.stringify(LANGUAGES)};`,
      'const decoded = Object.fromEntries(langs.map((language) => [language, Schema.decodeUnknownSync(PrefsSchema)({ language, liveEstimate: false, viewMode: "detailed" })]));',
      'const legacy = Schema.decodeUnknownSync(PrefsSchema)({ language: "es" });',
      'const legacyOff = Schema.decodeUnknownSync(PrefsSchema)({ language: "en", liveEstimate: false });',
      'const defaults = Schema.decodeUnknownSync(PrefsSchema)({ language: "en", liveEstimate: true, viewMode: "simple" });',
      'let rejected = false;',
      'try { Schema.decodeUnknownSync(PrefsSchema)({ language: "xx" }); } catch { rejected = true; }',
      'console.log(JSON.stringify({ decoded, legacy, legacyOff, defaults, rejected }));',
    ].join("\n");
    const output = execFileSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const parsed = JSON.parse(output) as {
      decoded: Record<string, unknown>;
      legacy: unknown;
      legacyOff: unknown;
      defaults: unknown;
      rejected: boolean;
    };
    for (const lang of LANGUAGES) {
      expect(parsed.decoded[lang]).toEqual({
        language: lang,
        liveEstimate: false,
        viewMode: "detailed",
      });
    }
    expect(parsed.legacy).toEqual({ language: "es", liveEstimate: true, viewMode: "simple" });
    expect(parsed.legacyOff).toEqual({ language: "en", liveEstimate: false, viewMode: "simple" });
    expect(parsed.defaults).toEqual({ language: "en", liveEstimate: true, viewMode: "simple" });
    expect(parsed.rejected).toBe(true);
  });
});

describe("locale-aware formatting for all ten languages", () => {
  it("formats rates, counts and durations against each Intl locale", () => {
    for (const lang of LANGUAGES) {
      expect(formatTps(1234.5, lang)).toBe(`${rateFormat(lang).format(1234.5)} tokens/s`);
      expect(formatTps(0, lang)).toBe(`${rateFormat(lang).format(0)} tokens/s`);
      expect(formatTokens(1234, lang)).toBe(intFormat(lang).format(1234));
      expect(formatTokens(0, lang)).toBe(intFormat(lang).format(0));
      expect(formatDuration(2000, lang)).toBe(`${rateFormat(lang).format(2)} s`);
      expect(formatTtft(800, lang)).toBe(`${intFormat(lang).format(800)} ms`);
      expect(formatTtft(1500, lang)).toBe(`${rateFormat(lang).format(1.5)} s`);
    }
  });

  it("keeps missing and invalid values unavailable, never zero", () => {
    for (const lang of LANGUAGES) {
      expect(formatTps(null, lang)).toBe("—");
      expect(formatTps(undefined, lang)).toBe("—");
      expect(formatTps(Number.NaN, lang)).toBe("—");
      expect(formatTps(-1, lang)).toBe("—");
      expect(formatTokens(null, lang)).toBe("—");
      expect(formatTokens(undefined, lang)).toBe("—");
      expect(formatTokens(Number.POSITIVE_INFINITY, lang)).toBe("—");
      expect(formatTokens(-1, lang)).toBe("—");
      expect(formatDuration(Number.NaN, lang)).toBe("—");
      expect(formatTtft(null, lang)).toBe("—");
    }
  });

  it("localizes unknown agents without renaming real agents", () => {
    for (const lang of LANGUAGES) {
      expect(agentLabel(null, lang)).toBe(LANGUAGE_META[lang].unknownAgent);
      expect(agentLabel(undefined, lang)).toBe(LANGUAGE_META[lang].unknownAgent);
      expect(agentLabel("build", lang)).toBe("build");
      expect(agentLabel("Orchestrator", lang)).toBe("Orchestrator");
    }
  });
});

describe("bidi interpolation helpers", () => {
  it("isolates technical and natural values only for Arabic without mutating input", () => {
    expect(bidiIsolate("50.0 tokens/s", "ltr")).toBe("\u206650.0 tokens/s\u2069");
    expect(bidiIsolate("Tarea 混合", "auto")).toBe("\u2068Tarea 混合\u2069");
    expect(isolateForLanguage("50.0 tokens/s", "ltr", "ar")).toBe("\u206650.0 tokens/s\u2069");
    expect(isolateForLanguage("Tarea 混合", "auto", "ar")).toBe("\u2068Tarea 混合\u2069");
    for (const lang of LANGUAGES.filter((value) => value !== "ar")) {
      expect(isolateForLanguage("Tarea 混合", "auto", lang)).toBe("Tarea 混合");
      expect(isolateForLanguage("50.0 tokens/s", "ltr", lang)).toBe("50.0 tokens/s");
    }
  });

  it("isolates each header provenance value independently in Arabic", () => {
    const mixed = "Tarea mixta 混合";
    const identity = { title: mixed, agent: "plan", isDelegate: true };
    expect(headerProvenance(identity, "ar")).toBe(`\u2068«${mixed}»\u2069 · \u2068plan\u2069`);
    expect(headerProvenance(identity, "en")).toBe(`«${mixed}» · plan`);
    expect(identity.title).toBe(mixed);
    expect(headerProvenance({ title: null, agent: "plan", isDelegate: true }, "ar")).toBe(
      "\u2068plan\u2069",
    );
    expect(headerProvenance({ title: mixed, agent: null, isDelegate: true }, "ar")).toBe(
      `\u2068«${mixed}»\u2069`,
    );
    expect(headerProvenance({ title: null, agent: null, isDelegate: true }, "ar")).toBe(
      LANGUAGE_META.ar.unknownAgent,
    );
    expect(headerProvenance(undefined, "ar")).toBe(t("ar", "scope.current"));
  });

  it("isolates Arabic scope names, diagnostic ids and technical params at display time", () => {
    const mixed = "Tarea mixta 混合";
    const tree = {
      rootSessionID: "root",
      children: [{ sessionID: "c1", title: mixed, agent: "plan", depth: 2 }],
    };
    expect(scopeDisplayName(tree, "c1", "ar")).toBe(`\u2068«${mixed}»\u2069`);
    expect(scopeDisplayName(tree, "c1", "en")).toBe(`«${mixed}»`);
    expect(scopeDisplayName(
      { rootSessionID: "root", children: [{ sessionID: "c1", title: null, agent: "plan", depth: 1 }] },
      "c1",
      "ar",
    )).toBe(`${t("ar", "scope.childName", { agent: "\u2068plan\u2069" })}`);
    expect(tree.children[0]!.title).toBe(mixed);

    const child = { kind: "child-unavailable", sessionID: "session-α" } as const;
    expect(diagnosticText(child, "ar")).toContain("\u2068session-α\u2069");
    expect(diagnosticText(child, "en")).toContain("session-α");
    const truncated = { kind: "history-truncated", pages: 2 } as const;
    expect(diagnosticText(truncated, "ar")).toContain(
      `\u2066${formatTokens(2, "ar")}\u2069`,
    );
    expect(diagnosticText(truncated, "en")).toContain("2");
    expect(diagnosticText(truncated, "en")).not.toContain("\u2066");
  });

  it("isolates Arabic trend summaries and scope option depths", () => {
    const peak = formatTps(10, "ar");
    const summary = trendSummary("ar", 2, peak);
    expect(summary).toContain(`\u2066${formatTokens(2, "ar")}\u2069`);
    expect(summary).toContain(`\u2066${peak}\u2069`);
    expect(trendSummary("en", 2, "10.0 tokens/s")).toBe(
      "2 completed responses; peak 10.0 tokens/s.",
    );
    const options = scopeOptionsFor(
      { rootSessionID: "root", children: [{ sessionID: "c1", title: null, agent: "plan", depth: 2 }] },
      "ar",
    );
    expect(options[1]!.detail).toContain(`\u2066${formatTokens(2, "ar")}\u2069`);
    const englishOptions = scopeOptionsFor(
      { rootSessionID: "root", children: [{ sessionID: "c1", title: null, agent: "plan", depth: 2 }] },
      "en",
    );
    expect(englishOptions[1]!.detail).not.toContain("\u2066");
  });

  it("keeps technical params coherent in Arabic model and live presentation", () => {
    const note = modelStatusNote(
      {
        entries: [{}],
        loading: false,
        disconnected: false,
        totalMeasuredActive: 2,
        totalObserved: 3,
      },
      "ar",
    );
    expect(note).toContain(`\u2066${formatTokens(2, "ar")}\u2069`);
    expect(note).toContain(`\u2066${formatTokens(3, "ar")}\u2069`);

    const live: LiveScopeSnapshot = {
      sessionID: "s1",
      phase: "streaming",
      messageID: "m1",
      stepStartedAt: 1000,
      estimatedTps: 10,
      elapsedMs: 1500,
      ttftMs: 800,
      ttftSource: "observed",
      activeTools: 0,
      streamEnded: false,
      active: true,
    };
    const row = liveRowPresentation(live, "ar", true, formatTps(50, "ar"));
    expect(row.estimate).toContain(`\u2066~${formatTps(10, "ar")}\u2069`);
    expect(row.detail).toContain(`\u2066${formatDuration(1500, "ar")}\u2069`);
    expect(row.detail).toContain(`\u2066${formatTps(50, "ar")}\u2069`);
    expect(row.ttft).toContain(`\u2066${formatTtft(800, "ar")}\u2069`);
    const english = liveRowPresentation(live, "en", true, "50.0 tokens/s");
    expect(english.estimate).toBe("~10.0 tokens/s");
    expect(english.detail).toContain("Elapsed 1.5 s");
    expect(english.ttft).toBe("800 ms observed");
  });
});

describe("scoped bidi and chart source contracts", () => {
  const gui = readFileSync(new URL("../src/gui.tsx", import.meta.url), "utf8");
  const view = readFileSync(new URL("../src/view.tsx", import.meta.url), "utf8");
  const controls = readFileSync(new URL("../src/controls.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/panel.css", import.meta.url), "utf8");
  const i18n = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
  const metrics = readFileSync(new URL("../src/metrics.ts", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/gui-hook.tsx", import.meta.url), "utf8");

  it("sets lang and dir only on plugin panel/header boundaries", () => {
    expect(gui).toContain("dir={languageDirection(lang())}");
    expect(view).toContain("dir={languageDirection(l())}");
    expect(view).toContain("lang={l()}");
    for (const source of [gui, view, controls]) {
      expect(source).not.toMatch(/document\.(?:documentElement|body)\.dir/);
      expect(source).not.toContain("document.dir");
    }
  });

  it("isolates rates with bdi LTR and verbatim names with natural direction", () => {
    expect(view).toContain('bdi dir="ltr"');
    expect(view).toContain('bdi dir="auto"');
    expect(controls).toContain("dir={option.dir}");
    expect(controls).toContain('<bdi dir="auto">');
    expect(controls).toContain("selected()?.dir");
    expect(view).toContain("title={label()}");
  });

  it("keeps each rate value and unit in one atomic LTR fragment", () => {
    expect(view).toContain("function RateValue");
    expect(view.match(/<RateValue value=/g)).toHaveLength(4);
    expect(view).toContain('class="tps-rate" dir="ltr"');
    expect(view).not.toContain('<span class="tps-unit" dir="ltr">');
    expect(css).toContain(".tps-rate {");
    expect(css).toContain("direction: ltr;");
    expect(css).toContain("unicode-bidi: isolate;");
  });

  it("keeps chart geometry and older-left/newer-right order LTR in Arabic", () => {
    expect(view).toContain('<div class="tps-chart" dir="ltr">');
    expect(view).toContain("left: `${xOf(point.id)}%`");
    expect(view).toContain("top: `${yOf(point)}%`");
    expect(css).toContain("direction: ltr;");
    expect(css).toContain(".tps-chart-dot");
    expect(css).toContain("margin: -3px 0 0 -3px");
    // Geometry helpers have no language input and are unchanged by Arabic.
    expect(trendPointX(0, 3)).toBe(2);
    expect(trendPointX(1, 3)).toBe(50);
    expect(trendPointX(2, 3)).toBe(98);
    expect(trendPointY(20, 20)).toBe(TREND_Y_TOP);
    expect(trendPointY(10, 20)).toBe(50);
    expect(trendPointY(0, 20)).toBe(TREND_Y_BOTTOM);
  });

  it("uses logical CSS for menus, units, switches, tables and disclosure chevrons", () => {
    expect(css).toContain("inset-inline-start: 0");
    expect(css).toContain("inset-inline-end: 0");
    expect(css).toContain("inset-inline-start: auto");
    expect(css).toContain("margin-inline-start: 5px");
    expect(css).toContain("inset-inline-start: 2px");
    expect(css).toContain("translateX(-14px)");
    expect(css).toContain("text-align: start");
    expect(css).toContain("text-align: end");
    expect(css).toContain('.tps-root[dir="rtl"] .tps-agent-head::before');
    expect(css).toContain('.tps-root[dir="rtl"] .tps-switch-input:checked');
    expect(css).not.toMatch(/html\[dir|:root\[dir/);
  });

  it("preserves mixed-script data verbatim in Arabic", () => {
    const mixed = "Tarea mixta 混合 النص";
    const tree = {
      rootSessionID: "root",
      children: [{ sessionID: "c1", title: mixed, agent: "plan", depth: 1 }],
    };
    expect(scopeDisplayName(tree, "c1", "ar")).toBe(`\u2068«${mixed}»\u2069`);
    expect(tree.children[0]!.title).toBe(mixed);
    expect(t("ar", "header.workingDelegate", { identity: `«${mixed}»` })).toContain(`«${mixed}»`);
    expect(agentLabel("Orchestrator", "ar")).toBe("Orchestrator");
    expect(agentLabel("my-custom", "ar")).toBe("my-custom");
  });

  it("keeps the GUI registry aligned and does not reload metrics on language", () => {
    expect(gui.match(/"command.open":/g)).toHaveLength(10);
    expect(gui.match(/"menu.open":/g)).toHaveLength(10);
    expect(gui.match(/"panel.title":/g)).toHaveLength(10);
    const registry = new Map<string, string>();
    for (const match of gui.matchAll(
      /(?:"([^"]+)"|([a-z]{2})): \{\s*"command\.open": "([^"]+)"/g,
    )) {
      registry.set(match[1] ?? match[2]!, match[3]!);
    }
    expect(Object.fromEntries(registry)).toEqual(
      Object.fromEntries(LANGUAGES.map((lang) => [lang, t(lang, "command.open")])),
    );
    expect(gui).not.toContain("createEffect");
    expect(hook).not.toContain("prefs");
    expect(hook).not.toMatch(/\blang\b/);
    expect(hook).not.toContain("preferenceFromStoreValue");
    expect(view).not.toMatch(/createEffect\([^)]*props\.lang/s);
    // Formatting is a one-way dependency: metrics never imports the translator.
    expect(i18n).toContain('from "./metrics.js"');
    expect(metrics).not.toContain('from "./i18n.js"');
  });
});
