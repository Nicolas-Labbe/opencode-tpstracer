/**
 * Shared ref-counted tree owner for the header and the panel.
 *
 * Both surfaces use one `SessionTreeController` per verified
 * server/session key: one discovery walk, one set of root/child
 * controllers, and one set of subscriptions. Opening or closing the
 * panel never resets header state or disposes its controllers; the last
 * consumer to release disposes exactly once. Re-attaching with new
 * client/data identities renews the pinned connection (clearing stale
 * delegate activity and re-bootstrapping the live connection), while an
 * unchanged connection is a no-op without reloads.
 */

import { SessionTreeController, type TreeControllerOptions } from "./orchestrator.js";
import { sessionKey } from "./adapter.js";

interface TreeEntry {
  tree: SessionTreeController;
  refs: number;
}

const trees = new Map<string, TreeEntry>();

export function retainSharedTree(
  serverID: string,
  rootSessionID: string,
  options: TreeControllerOptions,
): { key: string; tree: SessionTreeController; fresh: boolean } {
  const key = sessionKey(serverID, rootSessionID);
  const existing = trees.get(key);
  if (existing) {
    existing.refs += 1;
    existing.tree.replaceConnection({
      listPage: options.listPage,
      seamForSession: options.seamForSession,
      subscribeTree: options.subscribeTree,
      isConnected: options.isConnected,
      refs: options.refs,
      ...(options.snapshotRunning !== undefined ? { snapshotRunning: options.snapshotRunning } : {}),
    });
    return { key, tree: existing.tree, fresh: false };
  }
  const tree = new SessionTreeController(options);
  trees.set(key, { tree, refs: 1 });
  return { key, tree, fresh: true };
}

export function releaseSharedTree(key: string): void {
  const entry = trees.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    trees.delete(key);
    entry.tree.dispose();
  }
}

/** Test/owner escape hatch: number of live shared trees. */
export function liveTreeEntries(): number {
  return trees.size;
}
