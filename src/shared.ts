/**
 * Shared per-session controller cache.
 *
 * The header indicator and the side panel read the same controller for the
 * routed session instead of opening redundant subscriptions. Entries are
 * reference-counted and disposed when the last consumer releases them, so
 * session/server switches cannot leak timers, requests or listeners.
 *
 * A re-attach for an existing key renews the pinned connection
 * (`replaceTransport`): a restarted server's new client/data objects replace
 * the stale ones, while an unchanged connection is a no-op without reloads.
 */

import { SessionMetricsController, sessionKey } from "./adapter.js";
import type { TransportSeam } from "./transport.js";

interface Entry {
  controller: SessionMetricsController;
  refs: number;
}

const entries = new Map<string, Entry>();

export function retainController(
  serverID: string,
  sessionID: string,
  transport: TransportSeam,
  create: (transport: TransportSeam) => SessionMetricsController,
  opts?: { readonly renewReload?: boolean },
): { key: string; controller: SessionMetricsController; fresh: boolean } {
  const key = sessionKey(serverID, sessionID);
  const existing = entries.get(key);
  if (existing) {
    existing.refs += 1;
    existing.controller.replaceTransport(
      transport,
      opts?.renewReload === false ? { reload: false } : undefined,
    );
    return { key, controller: existing.controller, fresh: false };
  }
  const controller = create(transport);
  entries.set(key, { controller, refs: 1 });
  return { key, controller, fresh: true };
}

export function releaseController(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entries.delete(key);
    entry.controller.dispose();
  }
}

/** Test/owner escape hatch: number of live cached entries. */
export function liveEntries(): number {
  return entries.size;
}
