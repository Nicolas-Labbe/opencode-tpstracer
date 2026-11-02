/**
 * Bounded, paginated descendant discovery for delegated sessions.
 *
 * Walks verified same-server `parentID` relations starting at the selected
 * root: only descendants are included, forks (`fork` present) and unrelated
 * sessions are excluded, ids dedupe, cycles terminate, and every page is
 * followed via the response cursor. Discovery limits surface as an explicit
 * partial result, never as a fabricated complete tree or a summed TPS total.
 */

import type { SessionInfo, SessionsResponse } from "@opencode/client/promise";
import type { DiagnosticReason } from "./definition.js";

export interface TreeNode {
  readonly info: SessionInfo;
  readonly parentID: string;
  readonly depth: number;
}

export interface TreeDiscovery {
  readonly nodes: readonly TreeNode[];
  /** True when caps/cycles/errors cut the walk short. */
  readonly partial: boolean;
  readonly error: string | null;
  /** First-party reason as data; null for verbatim third-party failures. */
  readonly errorReason?: DiagnosticReason | null;
}

/** One paginated `session.list({ parentID, cursor, limit })` call. */
export type ListSessionsPage = (input: {
  readonly parentID: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}) => Promise<SessionsResponse>;

export interface DiscoverOptions {
  readonly pageLimit?: number;
  /** Max history pages per parent before marking partial. */
  readonly safetyPageCap?: number;
  /** Max descendant sessions before marking partial. */
  readonly maxSessions?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_PAGE_LIMIT = 50;
const DEFAULT_SAFETY_PAGE_CAP = 50;
const DEFAULT_MAX_SESSIONS = 100;

function isForked(info: SessionInfo): boolean {
  return info.fork !== undefined && info.fork !== null;
}

async function listChildren(
  listPage: ListSessionsPage,
  parentID: string,
  options: Required<Omit<DiscoverOptions, "signal">> & { signal?: AbortSignal },
): Promise<{
  children: SessionInfo[];
  complete: boolean;
  reason: string | null;
  reasonCode: DiagnosticReason | null;
}> {
  const children: SessionInfo[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    if (options.signal?.aborted)
      return { children, complete: false, reason: "discovery cancelled", reasonCode: { kind: "discovery-cancelled" } };
    if (pages >= options.safetyPageCap) {
      return {
        children,
        complete: false,
        reason: `discovery truncated after ${pages} pages`,
        reasonCode: { kind: "discovery-truncated", pages },
      };
    }
    const res = await listPage({
      parentID,
      ...(cursor !== undefined ? { cursor } : {}),
      limit: options.pageLimit,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    pages += 1;
    for (const info of res.data ?? []) {
      if (info && typeof info.id === "string") children.push(info);
    }
    const next = res.cursor?.next ?? null;
    if (!next) return { children, complete: true, reason: null, reasonCode: null };
    if (seenCursors.has(next)) {
      return {
        children,
        complete: false,
        reason: "repeated session cursor; tree incomplete",
        reasonCode: { kind: "repeated-session-cursor" },
      };
    }
    seenCursors.add(next);
    cursor = next;
  }
}

/**
 * Discover verified descendants of `rootID`. Breadth-first so depth labels
 * stay correct; siblings are walked in listed order with dedupe by id.
 */
export async function discoverDescendants(
  rootID: string,
  listPage: ListSessionsPage,
  options: DiscoverOptions = {},
): Promise<TreeDiscovery> {
  const opts = {
    pageLimit: options.pageLimit ?? DEFAULT_PAGE_LIMIT,
    safetyPageCap: options.safetyPageCap ?? DEFAULT_SAFETY_PAGE_CAP,
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
    signal: options.signal,
  };
  const seen = new Set<string>([rootID]);
  const nodes: TreeNode[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootID, depth: 0 }];
  let partial = false;
  let error: string | null = null;
  let errorReason: DiagnosticReason | null = null;

  while (queue.length > 0) {
    if (opts.signal?.aborted) {
      partial = true;
      error = error ?? "discovery cancelled";
      errorReason = errorReason ?? { kind: "discovery-cancelled" };
      break;
    }
    const current = queue.shift();
    if (!current) break;
    let children: SessionInfo[];
    try {
      const res = await listChildren(listPage, current.id, opts);
      children = res.children;
      if (!res.complete) {
        partial = true;
        error = error ?? res.reason;
        errorReason = errorReason ?? res.reasonCode;
      }
    } catch (err) {
      partial = true;
      if (err instanceof Error) {
        error = error ?? err.message;
      } else {
        error = error ?? "could not read child sessions";
        errorReason = errorReason ?? { kind: "children-unreadable" };
      }
      continue;
    }
    for (const info of children) {
      if (opts.signal?.aborted) break;
      if (seen.has(info.id)) continue;
      // Exclude forks and self-parent cycles explicitly; keep the id marked
      // so a repeated reference can never reopen the walk.
      if (isForked(info) || info.id === current.id) {
        seen.add(info.id);
        continue;
      }
      // Only verified direct children: the server's parentID filter already
      // scopes the page, but a mismatched payload must not join the tree.
      if (info.parentID !== current.id) continue;
      seen.add(info.id);
      if (nodes.length >= opts.maxSessions) {
        partial = true;
        error = error ?? `child session limit of ${opts.maxSessions} reached`;
        errorReason = errorReason ?? { kind: "max-sessions", max: opts.maxSessions };
        continue;
      }
      nodes.push({ info, parentID: current.id, depth: current.depth + 1 });
      queue.push({ id: info.id, depth: current.depth + 1 });
    }
  }

  return { nodes, partial, error, errorReason };
}
