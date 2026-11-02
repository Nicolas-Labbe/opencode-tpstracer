/**
 * Shared snapshot hook for TPSTracer containers.
 *
 * Thin reactive shell over the ref-counted `SessionTreeController` per
 * verified server/session key between the compact header and the side
 * panel (see shared-tree.ts): one discovery walk, one set of root/child
 * controllers, and one set of subscriptions. The header intentionally
 * starts the same bounded discovery and descendant histories so it can
 * follow the most recently active verified delegate; no periodic
 * full-tree polling or per-delta discovery fan-out is added. Language
 * changes never recreate the controller: hooks read no language state.
 */

import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { createEmptyTreeSnapshot } from "./snapshots.js";
import { sessionKey } from "./adapter.js";
import { SessionTreeController, type TreeSnapshot } from "./orchestrator.js";
import { releaseSharedTree, retainSharedTree } from "./shared-tree.js";
import { seamFor, sessionListerFor } from "./transport.js";
import type { Data } from "@opencode/client/solid";
import type { MountedSession } from "@opencode/plugin/gui";

/**
 * Shared tree hook for the header and the panel.
 *
 * Both containers retain the same ref-counted tree for the same
 * server/root key; closing one never disposes the other's controllers.
 * Route/server changes dispose the previous share and start a new one;
 * same-server client/data renewal refreshes in place and clears stale
 * delegate activity; stale generations cannot overwrite the new root.
 *
 * Running-state bootstrap has two channels, both idempotent and
 * history-free:
 * - `snapshotRunning` (read untracked inside the imperative lifecycle, so
 *   Data activity changes alone never retrigger ownership, renewal, or
 *   discovery) covers initial load, renewal, and reconnect;
 * - the dedicated reconcile effect below reads `data.session.active()`
 *   reactively and forwards it to `tree.reconcileRunning`, which touches
 *   only delegate activity and emits only on a selection change: no
 *   history fetch, no discovery walk, no polling, and never an overwrite
 *   of an explicit status event.
 */
function useSharedTree(getSession: () => MountedSession) {
  const [tree, setTree] = createSignal<TreeSnapshot>(createEmptyTreeSnapshot(""));
  const [connected, setConnected] = createSignal(true);
  const [binding, setBinding] = createSignal<{ tree: SessionTreeController; data: Data } | null>(null);
  let sharedKey: string | null = null;
  let sharedTree: SessionTreeController | null = null;
  let unwatch: (() => void) | null = null;
  let wasLive = true;

  // Live running-set reconcile: reactive in Data activity only. Ownership
  // (retain/release/renew/discovery) lives in the effect below; this one
  // never retains, never reloads histories, and never walks discovery.
  createEffect(() => {
    const b = binding();
    if (!b) return;
    let ids: readonly string[] = [];
    try {
      const active = b.data.session.active();
      ids = Array.isArray(active) ? active.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    } catch {
      ids = [];
    }
    b.tree.reconcileRunning(ids);
  });

  createEffect(() => {
    const session = getSession();
    const server = session.server;
    const client = server.client;
    const data = server.data;
    const live = server.connected;
    setConnected(live);
    const key = sessionKey(server.id, session.id);
    const seamForSession = (sid: string) => seamFor(client, data, () => server.connected, sid);
    const capturedData = data;
    const snapshotRunning = (): readonly string[] =>
      untrack(() => {
        try {
          const active = capturedData.session.active();
          return Array.isArray(active) ? active.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
        } catch {
          return [];
        }
      });

    if (sharedKey !== key || !sharedTree) {
      if (sharedKey !== null) {
        unwatch?.();
        unwatch = null;
        releaseSharedTree(sharedKey);
      }
      const entry = retainSharedTree(server.id, session.id, {
        serverID: server.id,
        rootSessionID: session.id,
        listPage: sessionListerFor(client),
        seamForSession,
        subscribeTree: (notify) => capturedData.listen((event) => notify(event.details)),
        isConnected: () => server.connected,
        refs: { client, data },
        snapshotRunning,
      });
      sharedKey = entry.key;
      sharedTree = entry.tree;
      unwatch = entry.tree.onUpdate(setTree);
      setTree(entry.tree.getState());
      setBinding({ tree: entry.tree, data: capturedData });
      if (!live) entry.tree.markDisconnected();
      else if (entry.fresh) void untrack(() => entry.tree.load());
      wasLive = live;
      return;
    }
    setBinding({ tree: sharedTree, data: capturedData });
    const renewed = sharedTree.replaceConnection({
      listPage: sessionListerFor(client),
      seamForSession,
      subscribeTree: (notify) => capturedData.listen((event) => notify(event.details)),
      isConnected: () => server.connected,
      refs: { client, data },
      snapshotRunning,
    });
    if (!live) {
      if (wasLive) sharedTree.markDisconnected();
    } else if (!wasLive && !renewed) {
      sharedTree.reconnect();
    }
    wasLive = live;
  });

  onCleanup(() => {
    unwatch?.();
    unwatch = null;
    setBinding(null);
    if (sharedKey !== null) releaseSharedTree(sharedKey);
    sharedKey = null;
    sharedTree = null;
  });

  const retry = () => sharedTree?.reconnect();
  const refresh = () => sharedTree?.refreshAll();
  return { tree, connected, retry, refresh };
}

/**
 * Panel tree hook: shares one ref-counted tree with the header (see
 * `useSharedTree`). The panel keeps its independent scope selection in
 * the view; the shared tree never selects for it.
 */
export function usePanelTree(getSession: () => MountedSession) {
  return useSharedTree(getSession);
}

/**
 * Header tree hook: same shared owner as the panel, so the compact badge
 * follows the most recently active verified delegate without duplicating
 * discovery, histories, or subscriptions.
 */
export function useHeaderTree(getSession: () => MountedSession) {
  return useSharedTree(getSession);
}
