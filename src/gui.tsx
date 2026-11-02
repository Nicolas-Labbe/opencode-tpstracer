/**
 * TPSTracer GUI entry (`./gui-experimental`).
 *
 * Header indicator (session.header slot), side panel, palette command and
 * side-menu launcher share one controller per server/session key (see
 * shared.ts). History comes from the session's own server client
 * (`client.message.list`, assistant pages via cursor); events only trigger
 * coalesced reloads and delta chunks are never counted as tokens.
 *
 * English is the default interface language regardless of host locale;
 * every other supported language is an explicit opt-in persisted through the
 * official GUI `Store.global` preference API (plugin-scoped, no global config
 * files or server storage). All surfaces read the same preference reactively
 * and change immediately without reloading metrics.
 */

import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  Slot,
  Store,
  Style,
  usePlugin,
  type MountedSession,
  type SetupContext,
} from "@opencode/plugin/gui";
import { useHeaderTree, usePanelTree } from "./gui-hook.js";
import { headerScopeForTree } from "./activity.js";
import { HeaderBadge, TreePanelView } from "./view.js";
import {
  liveEstimateFromStoreValue,
  normalizeLanguage,
  preferenceFromStoreValue,
  t,
  viewModeFromStoreValue,
} from "./i18n.js";
import { liveSnapshotFor } from "./presentation.js";
import { DEFAULT_PREFS, PrefsSchema } from "./prefs.js";
import type { Language, ViewMode } from "./definition.js";
import { languageDirection, normalizeViewMode } from "./definition.js";
import panelCss from "./panel.css?inline";

const definition = {
  stores: {
    prefs: Store.global(PrefsSchema, DEFAULT_PREFS),
  },
  i18n: {
    en: {
      "command.open": "Open TPSTracer throughput",
      "menu.open": "TPSTracer",
      "panel.title": "TPSTracer",
    },
    es: {
      "command.open": "Abrir rendimiento TPSTracer",
      "menu.open": "TPSTracer",
      "panel.title": "TPSTracer",
    },
    pt: {
      "command.open": "Abrir vazão do TPSTracer",
      "menu.open": "TPSTracer",
      "panel.title": "TPSTracer",
    },
    fr: {
      "command.open": "Ouvrir le débit TPSTracer",
      "menu.open": "TPSTracer",
      "panel.title": "TPSTracer",
    },
    de: {
      "command.open": "TPSTracer-Durchsatz öffnen",
      "menu.open": "TPSTracer",
      "panel.title": "TPSTracer",
    },
    it: {
      "command.open": "Apri rendimento TPSTracer",
      "menu.open": "TPSTracer",
      "panel.title": "TPSTracer",
    },
    "zh-CN": {
      "command.open": "打开 TPSTracer 吞吐量",
      "menu.open": "TPSTracer",
      "panel.title": "TPSTracer",
    },
    ja: {
      "command.open": "TPSTracer のスループットを開く",
      "menu.open": "TPSTracer",
      "panel.title": "TPSTracer",
    },
    ko: {
      "command.open": "TPSTracer 처리량 열기",
      "menu.open": "TPSTracer",
      "panel.title": "TPSTracer",
    },
    ar: {
      "command.open": "فتح إنتاجية TPSTracer",
      "menu.open": "TPSTracer",
      "panel.title": "TPSTracer",
    },
  },
} as const;

function HeaderContainer(props: { session: MountedSession }) {
  const ctx = usePlugin<typeof definition>();
  const sessionOf = () => props.session;
  const { tree, connected } = useHeaderTree(sessionOf);
  const open = () => ctx.layout.open(`${ctx.id}:main`, sessionOf());
  const lang = () => normalizeLanguage(preferenceFromStoreValue(ctx.stores.prefs.value));
  const liveEstimate = () => liveEstimateFromStoreValue(ctx.stores.prefs.value);
  const selection = () => headerScopeForTree(tree(), tree().activeDelegateID);
  const live = () => liveSnapshotFor(tree().live, selection().sessionID);
  const identity = () => ({
    sessionID: selection().sessionID,
    title: selection().title,
    agent: selection().agent,
    isDelegate: selection().isDelegate,
  });
  const follow = () => ({
    partial: tree().partial,
    reason: tree().errorReason ?? null,
    verbatim: tree().errorReason ? null : tree().error,
  });
  return (
    <HeaderBadge
      snap={selection().snap}
      connected={connected()}
      onOpen={open}
      lang={lang()}
      live={live()}
      estimateEnabled={liveEstimate()}
      identity={identity()}
      follow={follow()}
    />
  );
}

function PanelContainer(props: { session: MountedSession }) {
  const ctx = usePlugin<typeof definition>();
  const sessionOf = () => props.session;
  const { tree, connected, retry, refresh } = usePanelTree(sessionOf);
  const mode = () => ctx.appearance.mode();
  const lang = () => normalizeLanguage(preferenceFromStoreValue(ctx.stores.prefs.value));
  const liveEstimate = () => liveEstimateFromStoreValue(ctx.stores.prefs.value);
  const viewMode = () => viewModeFromStoreValue(ctx.stores.prefs.value);
  const onLanguage = (next: Language) => {
    ctx.stores.prefs.update((draft) => {
      draft.language = normalizeLanguage(next);
    });
  };
  const onLiveEstimate = (next: boolean) => {
    ctx.stores.prefs.update((draft) => {
      draft.liveEstimate = next;
    });
  };
  const onViewMode = (next: ViewMode) => {
    ctx.stores.prefs.update((draft) => {
      draft.viewMode = normalizeViewMode(next);
    });
  };
  return (
    <div
      class="tps-panel-scroll"
      role="region"
      tabindex="0"
      lang={lang()}
      dir={languageDirection(lang())}
      aria-label={t(lang(), "panel.scrollAria")}
    >
      <TreePanelView
        tree={tree()}
        connected={connected()}
        mode={mode()}
        onRetry={retry}
        onRefresh={refresh}
        lang={lang()}
        onLanguage={onLanguage}
        live={tree().live}
        estimateEnabled={liveEstimate()}
        onEstimateChange={onLiveEstimate}
        viewMode={viewMode()}
        onViewMode={onViewMode}
      />
    </div>
  );
}

export default Plugin.define({
  ...definition,
  setup(ctx: SetupContext<typeof definition>) {
    ctx.add(Style, panelCss);
    const openFor = (session: MountedSession) => ctx.layout.open(`${ctx.id}:main`, session);

    const readLang = (): Language =>
      normalizeLanguage(preferenceFromStoreValue(ctx.stores.prefs.value));

    ctx.add(Command, (): Command => ({
      id: "open",
      get title() {
        return t(readLang(), "command.open");
      },
      section: "session",
      run: () => {
        const session = ctx.sessions.current();
        if (session) openFor(session);
      },
    }));

    ctx.add(MenuItem, (): import("@opencode/plugin/gui").MenuItem => ({
      menu: "session.panel",
      id: "open",
      get title() {
        return t(readLang(), "menu.open");
      },
      icon: "window-analytics",
      run: () => {
        const session = ctx.sessions.current();
        if (session) openFor(session);
      },
    }));

    const mainTab = {
      id: "main",
      get title() {
        return t(readLang(), "panel.title");
      },
      closable: "compact" as const,
      fallback: true,
    };

    ctx.add(Panel, {
      id: "main",
      region: "side",
      mobile: {
        get title() {
          return t(readLang(), "panel.title");
        },
        order: 45,
        kind: "menu",
        icon: "window-analytics",
      },
      list: (input) => (input.open.includes("main") ? [mainTab] : []),
      render: (props) => <PanelContainer session={props.session} />,
    });

    ctx.add(Slot, {
      at: "session.header",
      render: (input) => <HeaderContainer session={input.session} />,
    });
  },
});
