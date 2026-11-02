/**
 * Fresh empty snapshot factory for TPSTracer.
 *
 * Dependency-safe: runtime imports only metrics (pure, no cycles).
 * Adapter/tree types are type-only and erased at runtime, so adapter,
 * hook and orchestrator can share this without a module cycle.
 *
 * Every call returns NEW arrays and a NEW summary from `summarize([])`
 * (zero, internal count 0, UI dash contract). No frozen singleton is
 * shared, so one caller mutating its arrays/summary can never affect
 * another snapshot. Status/error/reason semantics stay with callers:
 * override via spread (e.g. `{ ...createEmptyAdapterSnapshot(), status:
 * "disconnected" }`); optional properties (`reason`, `errorReason`)
 * remain optional for hand-built snapshots.
 */

import { summarize } from "./metrics.js";
import type { AdapterSnapshot } from "./adapter.js";
import type { TreeSnapshot } from "./orchestrator.js";

/** Fresh idle adapter snapshot with empty arrays and a zero summary. */
export function createEmptyAdapterSnapshot(): AdapterSnapshot {
  return {
    status: "idle",
    samples: [],
    observations: [],
    summary: summarize([]),
    error: null,
  };
}

/** Fresh idle tree snapshot for one root, with a fresh empty root scope. */
export function createEmptyTreeSnapshot(rootSessionID: string): TreeSnapshot {
  return {
    status: "idle",
    rootSessionID,
    rootTitle: null,
    rootAgent: null,
    root: createEmptyAdapterSnapshot(),
    children: [],
    activeDelegateID: null,
    partial: false,
    error: null,
    live: [],
  };
}
