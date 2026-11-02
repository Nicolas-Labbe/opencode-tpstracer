import { describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionsResponse } from "@opencode/client/promise";
import { discoverDescendants, type ListSessionsPage } from "../src/tree.js";

function info(id: string, parentID?: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    projectID: "proj",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/tmp" },
    ...(parentID !== undefined ? { parentID } : {}),
    ...extra,
  } as SessionInfo;
}

function page(data: SessionInfo[], next: string | null): SessionsResponse {
  return { data, cursor: { previous: null, next } };
}

/** In-memory parentID -> children listing with cursor pagination. */
function memoryList(children: Map<string, SessionInfo[]>, opts: { fail?: Set<string> } = {}): ListSessionsPage {
  return async ({ parentID, cursor, limit }) => {
    if (opts.fail?.has(parentID)) throw new Error(`list failed for ${parentID}`);
    const all = children.get(parentID) ?? [];
    const start = cursor === undefined ? 0 : Number(cursor);
    const slice = all.slice(start, start + limit);
    const nextIndex = start + slice.length;
    return page(slice, nextIndex < all.length ? String(nextIndex) : null);
  };
}

describe("discoverDescendants", () => {
  it("finds children and grandchildren with depth and parent", async () => {
    const children = new Map<string, SessionInfo[]>([
      ["root", [info("c1", "root", { title: "task one", agent: "build" }), info("c2", "root")]],
      ["c1", [info("g1", "c1", { agent: "plan" })]],
      ["c2", []],
      ["g1", []],
    ]);
    const found = await discoverDescendants("root", memoryList(children));
    expect(found.partial).toBe(false);
    expect(found.error).toBeNull();
    const byId = new Map(found.nodes.map((n) => [n.info.id, n]));
    expect(byId.get("c1")).toMatchObject({ parentID: "root", depth: 1 });
    expect(byId.get("g1")).toMatchObject({ parentID: "c1", depth: 2 });
    expect(byId.get("c1")?.info.title).toBe("task one");
  });

  it("excludes forks and unrelated sessions", async () => {
    const children = new Map<string, SessionInfo[]>([
      [
        "root",
        [
          info("fork", "root", { fork: { sessionID: "root", boundary: { type: "before", messageID: "m" } } }),
          info("ok", "root"),
          // Mismatched payload that does not verify as this parent's child.
          info("stray", "elsewhere"),
        ],
      ],
      ["ok", []],
    ]);
    const found = await discoverDescendants("root", memoryList(children));
    expect(found.nodes.map((n) => n.info.id)).toEqual(["ok"]);
    expect(found.partial).toBe(false);
  });

  it("dedupes repeated ids and terminates cycles", async () => {
    const children = new Map<string, SessionInfo[]>([
      ["root", [info("a", "root"), info("a", "root")]],
      // A cycle back to the root must not reopen the walk.
      ["a", [info("root", "a")]],
    ]);
    const found = await discoverDescendants("root", memoryList(children));
    expect(found.nodes.map((n) => n.info.id)).toEqual(["a"]);
    expect(found.partial).toBe(false);
  });

  it("paginates child discovery instead of taking one page", async () => {
    const all = Array.from({ length: 5 }, (_, i) => info(`c${i}`, "root"));
    const found = await discoverDescendants("root", memoryList(new Map([["root", all]])), { pageLimit: 2 });
    expect(found.nodes).toHaveLength(5);
    expect(found.partial).toBe(false);
  });

  it("marks partial on a repeated session cursor", async () => {
    const listPage = vi.fn(async () => page([info("a", "root")], "loop"));
    // Second call repeats the same cursor forever.
    listPage.mockResolvedValue(page([info("a", "root")], "loop"));
    const found = await discoverDescendants("root", listPage);
    expect(found.partial).toBe(true);
    expect(found.error).toBe("repeated session cursor; tree incomplete");
    expect(found.errorReason).toEqual({ kind: "repeated-session-cursor" });
    expect(found.nodes.map((n) => n.info.id)).toEqual(["a"]);
  });

  it("marks partial when the page cap is hit with pages remaining", async () => {
    let n = 0;
    const listPage: ListSessionsPage = async () => {
      n += 1;
      return page([info(`c${n}`, "root")], `page-${n}`);
    };
    const found = await discoverDescendants("root", listPage, { safetyPageCap: 2 });
    expect(found.partial).toBe(true);
    expect(found.error).toBe("discovery truncated after 2 pages");
    expect(found.errorReason).toEqual({ kind: "discovery-truncated", pages: 2 });
  });

  it("marks partial when the session cap is reached", async () => {
    const all = Array.from({ length: 5 }, (_, i) => info(`c${i}`, "root"));
    const found = await discoverDescendants("root", memoryList(new Map([["root", all]])), { maxSessions: 2 });
    expect(found.nodes).toHaveLength(2);
    expect(found.partial).toBe(true);
    expect(found.error).toBe("child session limit of 2 reached");
    expect(found.errorReason).toEqual({ kind: "max-sessions", max: 2 });
  });

  it("keeps discovered nodes when one branch fails to list", async () => {
    const children = new Map<string, SessionInfo[]>([
      ["root", [info("ok", "root"), info("bad", "root")]],
      ["ok", []],
    ]);
    const found = await discoverDescendants(
      "root",
      memoryList(children, { fail: new Set(["bad"]) }),
    );
    expect(found.nodes.map((n) => n.info.id).sort()).toEqual(["bad", "ok"]);
    expect(found.partial).toBe(true);
    expect(found.error).toMatch(/bad/);
  });

  it("aborts promptly on an aborted signal without network calls", async () => {
    const listPage = vi.fn(async () => page([info("a", "root")], null));
    const aborter = new AbortController();
    aborter.abort();
    const found = await discoverDescendants("root", listPage, { signal: aborter.signal });
    expect(listPage).not.toHaveBeenCalled();
    expect(found.nodes).toEqual([]);
    expect(found.partial).toBe(true);
    expect(found.error).toBe("discovery cancelled");
    expect(found.errorReason).toEqual({ kind: "discovery-cancelled" });
  });

  it("reports an English fallback when a branch listing rejects without an Error", async () => {
    const listPage: ListSessionsPage = async ({ parentID }) => {
      if (parentID === "bad") throw "boom";
      if (parentID === "root") return page([info("ok", "root"), info("bad", "root")], null);
      return page([], null);
    };
    const found = await discoverDescendants("root", listPage);
    expect(found.partial).toBe(true);
    expect(found.error).toBe("could not read child sessions");
    expect(found.errorReason).toEqual({ kind: "children-unreadable" });
    expect(found.nodes.map((n) => n.info.id).sort()).toEqual(["bad", "ok"]);
  });
});
