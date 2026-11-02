/**
 * All-session model inventory for TPSTracer.
 *
 * Pure, framework-free selectors over root/child snapshots. The inventory is
 * separate from Current session history and independent of the selected
 * scope/agent filter: it groups every observed provider/model pair across
 * loaded sessions with session/title/agent provenance. Unmeasured rows
 * (failed/unfinished/missing-usage with known model metadata) stay
 * observable but never fabricate tokens or rates. Pooled per-model rates are
 * independently weighted paired per-step measurements, never aggregate
 * system throughput or a sum of concurrent agents. No extra API requests.
 */

import type { AdapterSnapshot } from "./adapter.js";
import type { TreeSnapshot } from "./orchestrator.js";

export const MODELS_INITIAL_COUNT = 6;
export const MODELS_STEP = 6;

export interface ModelScopeInput {
  readonly serverID: string;
  readonly sessionID: string;
  readonly title: string | null;
  readonly agent: string | null;
  readonly snapshot: AdapterSnapshot;
}

export interface ModelSessionProvenance {
  readonly serverID: string;
  readonly sessionID: string;
  readonly title: string | null;
  readonly agent: string | null;
  readonly agents: readonly (string | null)[];
  readonly observed: number;
  readonly measuredWall: number;
  readonly measuredActive: number;
}

export interface ModelInventoryEntry {
  readonly key: string;
  readonly provider: string | null;
  readonly modelId: string;
  readonly label: string;
  readonly observed: number;
  readonly measuredWall: number;
  readonly measuredActive: number;
  /** Measured-only output sum; null when no wall-measured samples (never invented zero). */
  readonly totalOutput: number | null;
  /** Measured-only reasoning sum; null when none measured or any measured omits it. */
  readonly totalReasoning: number | null;
  /** Measured-only generated sum; null when no active-measured samples. */
  readonly totalGenerated: number | null;
  readonly totalWallMs: number;
  readonly totalActiveMs: number;
  readonly weightedWallTps: number | null;
  readonly weightedPrimaryTps: number | null;
  readonly sessions: readonly ModelSessionProvenance[];
  readonly agents: readonly (string | null)[];
}

export interface ModelInventory {
  readonly entries: readonly ModelInventoryEntry[];
  readonly totalObserved: number;
  readonly totalMeasuredWall: number;
  readonly totalMeasuredActive: number;
  /** True when discovery/history left coverage incomplete; never imply full coverage then. */
  readonly partial: boolean;
  /** True while any scope or the tree is still loading/idle (in progress). */
  readonly loading: boolean;
  /** True when the tree or any scope reports disconnected. */
  readonly disconnected: boolean;
  readonly scopeCount: number;
}

function modelKey(provider: string | null, modelId: string): string {
  return `${provider ?? ""}\n${modelId}`;
}

function modelLabelOf(provider: string | null, modelId: string): string {
  return provider ? `${provider}/${modelId}` : modelId;
}

interface Accum {
  provider: string | null;
  modelId: string;
  observed: number;
  measuredWall: number;
  measuredActive: number;
  totalOutput: number;
  totalReasoning: number;
  reasoningUnknown: boolean;
  totalGenerated: number;
  totalWallMs: number;
  totalActiveMs: number;
  agents: Set<string | null>;
  perSession: Map<string, { serverID: string; sessionID: string; title: string | null; agent: string | null; agents: Set<string | null>; observed: number; measuredWall: number; measuredActive: number }>;
}

/**
 * Build the inventory from already loaded scopes. Dedupes by
 * server/session/message identity (never by message id alone), so equal ids
 * in different scopes stay distinct and repeated pages collapse.
 */
export function buildModelInventory(
  scopes: readonly ModelScopeInput[],
  opts?: { readonly partial?: boolean },
): ModelInventory {
  const seenObs = new Set<string>();
  const seenSamples = new Set<string>();
  const byModel = new Map<string, Accum>();
  let totalObserved = 0;
  let totalMeasuredWall = 0;
  let totalMeasuredActive = 0;

  const accumFor = (provider: string | null, modelId: string): Accum => {
    const key = modelKey(provider, modelId);
    let a = byModel.get(key);
    if (!a) {
      a = {
        provider,
        modelId,
        observed: 0,
        measuredWall: 0,
        measuredActive: 0,
        totalOutput: 0,
        totalReasoning: 0,
        reasoningUnknown: false,
        totalGenerated: 0,
        totalWallMs: 0,
        totalActiveMs: 0,
        agents: new Set(),
        perSession: new Map(),
      };
      byModel.set(key, a);
    }
    return a;
  };

  const perSessionKey = (serverID: string, sessionID: string): string => `${serverID}\n${sessionID}`;

  const ensurePerSession = (
    a: Accum,
    scope: ModelScopeInput,
  ): { serverID: string; sessionID: string; title: string | null; agent: string | null; agents: Set<string | null>; observed: number; measuredWall: number; measuredActive: number } => {
    const key = perSessionKey(scope.serverID, scope.sessionID);
    let per = a.perSession.get(key);
    if (!per) {
      per = { serverID: scope.serverID, sessionID: scope.sessionID, title: scope.title, agent: scope.agent, agents: new Set(), observed: 0, measuredWall: 0, measuredActive: 0 };
      a.perSession.set(key, per);
    }
    return per;
  };

  for (const scope of scopes) {
    for (const o of scope.snapshot.observations ?? []) {
      if (!o || typeof o.id !== "string" || o.id.length === 0) continue;
      const triple = `${scope.serverID}\n${scope.sessionID}\n${o.id}`;
      if (seenObs.has(triple)) continue;
      seenObs.add(triple);
      const provider = typeof o.provider === "string" && o.provider.length > 0 ? o.provider : null;
      const modelId = typeof o.modelId === "string" && o.modelId.length > 0 ? o.modelId : "unknown";
      const a = accumFor(provider, modelId);
      a.observed += 1;
      totalObserved += 1;
      a.agents.add(o.agent ?? null);
      const per = ensurePerSession(a, scope);
      per.observed += 1;
      per.agents.add(o.agent ?? null);
    }
    for (const s of scope.snapshot.samples) {
      if (!s || typeof s.id !== "string" || s.id.length === 0) continue;
      const triple = `${scope.serverID}\n${scope.sessionID}\n${s.id}`;
      if (seenSamples.has(triple)) continue;
      seenSamples.add(triple);
      // Model identity for a measured sample comes from its own label; split
      // provider/model on the first slash to stay consistent with observations.
      const slash = s.model.indexOf("/");
      const provider = slash >= 0 ? s.model.slice(0, slash) || null : null;
      const modelId = slash >= 0 ? s.model.slice(slash + 1) || "unknown" : s.model || "unknown";
      const a = accumFor(provider, modelId);
      a.measuredWall += 1;
      totalMeasuredWall += 1;
      a.totalOutput += s.output;
      if (s.reasoning === null) a.reasoningUnknown = true;
      else a.totalReasoning += s.reasoning;
      a.totalWallMs += s.durationMs;
      a.agents.add(s.agent ?? null);
      const per = ensurePerSession(a, scope);
      per.measuredWall += 1;
      per.agents.add(s.agent ?? null);
      if (s.primaryTps !== null && s.generated !== null && s.activeDurationMs !== null) {
        a.measuredActive += 1;
        totalMeasuredActive += 1;
        a.totalGenerated += s.generated;
        a.totalActiveMs += s.activeDurationMs;
        per.measuredActive += 1;
      }
    }
  }

  // Observations carry measuredActive only via samples; count active-measured
  // observations that never produced a wall sample is impossible by design
  // (active eligibility implies wall eligibility), so no extra pass is needed.

  const entries: ModelInventoryEntry[] = [...byModel.entries()].map(([key, a]) => {
    const wall = a.measuredWall === 0 || a.totalWallMs <= 0 ? null : a.totalOutput / (a.totalWallMs / 1000);
    const rawPrimary =
      a.measuredActive === 0 || a.totalActiveMs <= 0 ? null : a.totalGenerated / (a.totalActiveMs / 1000);
    const sortAgents = (set: Set<string | null>): (string | null)[] =>
      [...set].sort((x, y) => {
        if (x === null && y === null) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return x < y ? -1 : x > y ? 1 : 0;
      });
    const sessions: ModelSessionProvenance[] = [...a.perSession.entries()]
      .map(([, p]) => ({
        serverID: p.serverID,
        sessionID: p.sessionID,
        title: p.title,
        agent: p.agent,
        agents: sortAgents(p.agents),
        observed: p.observed,
        measuredWall: p.measuredWall,
        measuredActive: p.measuredActive,
      }))
      .sort((x, y) => {
        if (x.serverID !== y.serverID) return x.serverID < y.serverID ? -1 : 1;
        return x.sessionID < y.sessionID ? -1 : x.sessionID > y.sessionID ? 1 : 0;
      });
    const agents = sortAgents(a.agents);
    return {
      key,
      provider: a.provider,
      modelId: a.modelId,
      label: modelLabelOf(a.provider, a.modelId),
      observed: a.observed,
      measuredWall: a.measuredWall,
      measuredActive: a.measuredActive,
      totalOutput: a.measuredWall === 0 ? null : a.totalOutput,
      totalReasoning: a.measuredWall === 0 || a.reasoningUnknown ? null : a.totalReasoning,
      totalGenerated: a.measuredActive === 0 ? null : a.totalGenerated,
      totalWallMs: a.totalWallMs,
      totalActiveMs: a.totalActiveMs,
      weightedWallTps: wall !== null && Number.isFinite(wall) && wall >= 0 ? wall : null,
      weightedPrimaryTps:
        rawPrimary !== null && Number.isFinite(rawPrimary) && rawPrimary >= 0 ? rawPrimary : null,
      sessions,
      agents,
    };
  });
  entries.sort((a, b) => {
    if (b.observed !== a.observed) return b.observed - a.observed;
    if (b.measuredActive !== a.measuredActive) return b.measuredActive - a.measuredActive;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });

  return {
    entries,
    totalObserved,
    totalMeasuredWall,
    totalMeasuredActive,
    partial: opts?.partial ?? false,
    loading: false,
    disconnected: false,
    scopeCount: scopes.length,
  };
}

/** Convenience: root plus verified descendants, independent of selection. */
export function inventoryFromTree(serverID: string, tree: TreeSnapshot): ModelInventory {
  const scopes: ModelScopeInput[] = [
    { serverID, sessionID: tree.rootSessionID, title: tree.rootTitle, agent: tree.rootAgent, snapshot: tree.root },
    ...tree.children.map((c) => ({
      serverID,
      sessionID: c.sessionID,
      title: c.title,
      agent: c.agent,
      snapshot: c.snapshot,
    })),
  ];
  const scopePartial =
    tree.partial ||
    tree.root.status === "partial" ||
    tree.root.status === "error" ||
    tree.children.some((c) => c.snapshot.status === "error" || c.snapshot.status === "partial");
  const scopeLoading =
    tree.status === "loading" ||
    tree.status === "idle" ||
    tree.root.status === "loading" ||
    tree.root.status === "idle" ||
    tree.children.some((c) => c.snapshot.status === "loading" || c.snapshot.status === "idle");
  const scopeDisconnected =
    tree.status === "disconnected" ||
    tree.root.status === "disconnected" ||
    tree.children.some((c) => c.snapshot.status === "disconnected");
  const base = buildModelInventory(scopes, { partial: scopePartial });
  return { ...base, loading: scopeLoading, disconnected: scopeDisconnected };
}

/** Stable per-session display identity (server/session), for provenance keys. */
export function sessionScopeKey(serverID: string, sessionID: string): string {
  return `${serverID}\n${sessionID}`;
}
