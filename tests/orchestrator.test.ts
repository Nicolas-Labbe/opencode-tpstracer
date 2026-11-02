import { describe, expect, it } from "vitest";
import type {
  OpenCodeEvent,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessagesResponse,
  SessionsResponse,
} from "@opencode/client/promise";
import { SessionTreeController } from "../src/orchestrator.js";
import { liveEntries, releaseController, retainController } from "../src/shared.js";
import { SessionMetricsController } from "../src/adapter.js";
import type { FetchPage, TransportSeam } from "../src/transport.js";
import type { ListSessionsPage } from "../src/tree.js";

function assistant(
  id: string,
  created: number,
  completed: number,
  output = 100,
  agent = "build",
): SessionMessageAssistant {
  return {
    id,
    type: "assistant",
    agent,
    model: { providerID: "acme", id: "fast" },
    content: [],
    tokens: { input: 10, output, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, completed },
    finish: "stop",
  };
}

function session(id: string, parentID?: string, extra: Record<string, unknown> = {}): SessionInfo {
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

function msgPage(messages: SessionMessageInfo[], next: string | null = null): SessionMessagesResponse {
  return { data: messages, cursor: { previous: null, next } };
}

function sessionPage(data: SessionInfo[], next: string | null = null): SessionsResponse {
  return { data, cursor: { previous: null, next } };
}

interface Harness {
  controller: SessionTreeController;
  callsBySession: Map<string, number>;
  fire: (details: OpenCodeEvent) => void;
  children: Map<string, SessionInfo[]>;
  messages: Map<string, SessionMessageInfo[]>;
  unsubscribed: () => number;
  refs: { readonly client: unknown; readonly data: unknown };
  fetchPage: FetchPage;
}

const tick = () => new Promise((r) => setTimeout(r, 15));

function harness(
  serverID: string,
  rootID: string,
  opts: {
    children?: Map<string, SessionInfo[]>;
    messages?: Map<string, SessionMessageInfo[]>;
    failMessages?: Set<string>;
    debounceMs?: number;
    concurrency?: number;
    track?: { active: number; peak: number };
    listPage?: ListSessionsPage;
    fetchPage?: FetchPage;
  } = {},
): Harness {
  const children = opts.children ?? new Map();
  const messages = opts.messages ?? new Map();
  const callsBySession = new Map<string, number>();
  const track = opts.track;
  let treeNotify: ((details: OpenCodeEvent) => void) | null = null;
  let unsubs = 0;
  const refs = { client: {}, data: {} };

  const fetchPage: FetchPage =
    opts.fetchPage ??
    (async (input) => {
      callsBySession.set(input.sessionID, (callsBySession.get(input.sessionID) ?? 0) + 1);
      if (opts.failMessages?.has(input.sessionID)) throw new Error(`history failed for ${input.sessionID}`);
      if (track) {
        track.active += 1;
        track.peak = Math.max(track.peak, track.active);
        await new Promise((r) => setTimeout(r, 5));
        track.active -= 1;
      }
      return msgPage(messages.get(input.sessionID) ?? []);
    });

  const seamForSession = (sid: string): TransportSeam => {
    void sid;
    return {
      fetchPage,
      subscribe: () => () => {},
      isConnected: () => true,
      refs,
    };
  };

  const controller = new SessionTreeController({
    serverID,
    rootSessionID: rootID,
    listPage: opts.listPage ?? (async ({ parentID }) => sessionPage(children.get(parentID) ?? [])),
    seamForSession,
    subscribeTree: (notify) => {
      treeNotify = notify;
      return () => {
        treeNotify = null;
        unsubs += 1;
      };
    },
    isConnected: () => true,
    refs,
    debounceMs: opts.debounceMs ?? 0,
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  });
  return {
    controller,
    callsBySession,
    fire: (details) => treeNotify?.(details),
    children,
    messages,
    unsubscribed: () => unsubs,
    refs,
    fetchPage,
  };
}

function sessionEvent(sessionID: string): OpenCodeEvent {
  return {
    id: "e1",
    created: 1,
    type: "session.execution.succeeded",
    durable: { aggregateID: "a", seq: 1, version: 1 },
    data: { sessionID },
  } as unknown as OpenCodeEvent;
}

function createdEvent(sessionID: string, parentID: string): OpenCodeEvent {
  return {
    id: "e2",
    created: 2,
    type: "session.created",
    durable: { aggregateID: "a", seq: 2, version: 1 },
    data: { sessionID, parentID, projectID: "p", location: { directory: "/tmp" }, slug: "s", version: "1" },
  } as unknown as OpenCodeEvent;
}

describe("SessionTreeController", () => {
  it("loads root and children with independent scopes, never a summed TPS", async () => {
    const base = liveEntries();
    const h = harness("tor1", "root", {
      children: new Map([["root", [session("c1", "root", { title: "child task", agent: "plan" })]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000, 100)]],
        ["c1", [assistant("k1", 0, 8000, 100, "plan")]],
      ]),
    });
    await h.controller.load();
    const state = h.controller.getState();
    expect(state.children).toHaveLength(1);
    expect(state.children[0]).toMatchObject({ sessionID: "c1", title: "child task", agent: "plan", depth: 1 });
    // Independent scopes: root 100t/2s => 50, child 100t/8s => 12.5. No tree total exists.
    expect(state.root.summary.weightedTps).toBe(50);
    expect(state.children[0]?.snapshot.summary.weightedTps).toBe(12.5);
    expect(state.partial).toBe(false);
    h.controller.dispose();
    expect(liveEntries()).toBe(base);
  });

  it("keeps the root when a child history fails, marked partial", async () => {
    const h = harness("tor2", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([["root", [assistant("r1", 0, 2000)]]]),
      failMessages: new Set(["c1"]),
    });
    await h.controller.load();
    const state = h.controller.getState();
    expect(state.root.status).toBe("ready");
    expect(state.children[0]?.snapshot.status).toBe("error");
    expect(state.status).toBe("partial");
    expect(state.partial).toBe(true);
    expect(state.error).toMatch(/c1/);
    h.controller.dispose();
  });

  it("ignores events from unrelated sessions without any reload", async () => {
    const h = harness("tor3", "root", {
      messages: new Map([["root", [assistant("r1", 0, 2000)]]]),
    });
    await h.controller.load();
    const before = h.callsBySession.get("root") ?? 0;
    h.fire(sessionEvent("unrelated-session"));
    await tick();
    expect(h.callsBySession.get("root") ?? 0).toBe(before);
    h.controller.dispose();
  });

  it("refreshes only the relevant child on child events", async () => {
    const h = harness("tor4", "root", {
      children: new Map([["root", [session("c1", "root"), session("c2", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
        ["c2", [assistant("k2", 0, 2000)]],
      ]),
    });
    await h.controller.load();
    const rootBefore = h.callsBySession.get("root") ?? 0;
    const c1Before = h.callsBySession.get("c1") ?? 0;
    const c2Before = h.callsBySession.get("c2") ?? 0;
    h.fire(sessionEvent("c1"));
    await tick();
    await tick();
    expect(h.callsBySession.get("c1") ?? 0).toBeGreaterThan(c1Before);
    expect(h.callsBySession.get("c2") ?? 0).toBe(c2Before);
    expect(h.callsBySession.get("root") ?? 0).toBe(rootBefore);
    h.controller.dispose();
  });

  it("discovers a new child when a creation names a known parent", async () => {
    const h = harness("tor5", "root", {
      children: new Map(),
      messages: new Map([["root", [assistant("r1", 0, 2000)]]]),
    });
    await h.controller.load();
    expect(h.controller.getState().children).toHaveLength(0);
    h.children.set("root", [session("c9", "root", { agent: "explore" })]);
    h.messages.set("c9", [assistant("k9", 0, 1000)]);
    h.fire(createdEvent("c9", "root"));
    await tick();
    await tick();
    await tick();
    expect(h.controller.getState().children.map((c) => c.sessionID)).toEqual(["c9"]);
    h.controller.dispose();
  });

  it("bounds concurrent history loads", async () => {
    const track = { active: 0, peak: 0 };
    const kids = Array.from({ length: 5 }, (_, i) => session(`cc${i}`, "root"));
    const messages = new Map<string, SessionMessageInfo[]>([
      ["root", [assistant("r1", 0, 2000)]],
      ...kids.map((k): [string, SessionMessageInfo[]] => [k.id, [assistant(`${k.id}-m`, 0, 2000)]]),
    ]);
    const h = harness("tor6", "root", {
      children: new Map([["root", kids]]),
      messages,
      concurrency: 2,
      track,
    });
    await h.controller.load();
    expect(h.controller.getState().children).toHaveLength(5);
    expect(track.peak).toBeLessThanOrEqual(2);
    expect(track.peak).toBeGreaterThan(0);
    h.controller.dispose();
  });

  it("dispose cleans up subscriptions and shared controllers", async () => {
    const base = liveEntries();
    const h = harness("tor7", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
      ]),
    });
    await h.controller.load();
    expect(liveEntries()).toBeGreaterThan(base);
    const callsBefore = h.callsBySession.get("root") ?? 0;
    h.controller.dispose();
    expect(liveEntries()).toBe(base);
    expect(h.unsubscribed()).toBe(1);
    h.fire(sessionEvent("root"));
    await tick();
    expect(h.callsBySession.get("root") ?? 0).toBe(callsBefore);
  });

  it("replaceConnection is a no-op for the same connection and renews on change", async () => {
    const base = liveEntries();
    const h = harness("tor8", "root", {
      messages: new Map([["root", [assistant("r1", 0, 2000)]]]),
    });
    await h.controller.load();
    expect(h.controller.getState().root.status).toBe("ready");
    const callsBefore = h.callsBySession.get("root") ?? 0;

    const renewedSame = h.controller.replaceConnection({
      listPage: async () => sessionPage([]),
      seamForSession: () => ({
        fetchPage: h.fetchPage,
        subscribe: () => () => {},
        isConnected: () => true,
        refs: h.refs,
      }) as TransportSeam,
      subscribeTree: (notify) => {
        void notify;
        return () => {};
      },
      isConnected: () => true,
      refs: h.refs,
    });
    expect(renewedSame).toBe(false);
    await tick();
    expect(h.callsBySession.get("root") ?? 0).toBe(callsBefore);

    const nextRefs = { client: {}, data: {} };
    const renewedNew = h.controller.replaceConnection({
      listPage: async () => sessionPage([]),
      seamForSession: () => ({
        fetchPage: h.fetchPage,
        subscribe: () => () => {},
        isConnected: () => true,
        refs: nextRefs,
      }) as TransportSeam,
      subscribeTree: (notify) => {
        void notify;
        return () => {};
      },
      isConnected: () => true,
      refs: nextRefs,
    });
    expect(renewedNew).toBe(true);
    await tick();
    await tick();
    // Renewal reloads the root scope through the new seam.
    expect(h.callsBySession.get("root") ?? 0).toBeGreaterThan(callsBefore);
    expect(h.controller.getState().root.status).toBe("ready");
    h.controller.dispose();
    expect(liveEntries()).toBe(base);
  });

  it("cancel drops late discovery results for a stale generation", async () => {
    const h = harness("tor9", "root", {
      messages: new Map([["root", [assistant("r1", 0, 2000)]]]),
    });
    const pending = h.controller.load();
    h.controller.cancel();
    await pending;
    // Cancelled work never resolves into a ready tree.
    expect(h.controller.getState().status).not.toBe("ready");
    h.controller.dispose();
  });

  it("manual refresh reloads ready and error scopes alike", async () => {
    const fail = new Set(["c1"]);
    const h = harness("tor10", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
      ]),
      failMessages: fail,
    });
    await h.controller.load();
    expect(h.controller.getState().children[0]?.snapshot.status).toBe("error");
    const rootBefore = h.callsBySession.get("root") ?? 0;
    const c1Before = h.callsBySession.get("c1") ?? 0;
    fail.clear();
    h.controller.refreshAll();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.callsBySession.get("root") ?? 0).toBeGreaterThan(rootBefore);
    expect(h.callsBySession.get("c1") ?? 0).toBeGreaterThan(c1Before);
    const state = h.controller.getState();
    expect(state.children[0]?.snapshot.status).toBe("ready");
    expect(state.partial).toBe(false);
    h.controller.dispose();
  });

  it("reconnect on the same connection recovers after disconnect", async () => {
    const base = liveEntries();
    const h = harness("tor11", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
      ]),
    });
    await h.controller.load();
    expect(h.controller.getState().root.status).toBe("ready");
    h.controller.markDisconnected();
    // The tree reports disconnected; the shared root controller is left to
    // its other consumers (header), while owned children go disconnected.
    expect(h.controller.getState().status).toBe("disconnected");
    expect(h.controller.getState().children[0]?.snapshot.status).toBe("disconnected");
    expect(liveEntries()).toBe(base + 1);
    h.controller.reconnect();
    await new Promise((r) => setTimeout(r, 50));
    const state = h.controller.getState();
    expect(state.root.status).toBe("ready");
    expect(state.root.samples).toHaveLength(1);
    expect(state.children[0]?.snapshot.status).toBe("ready");
    h.controller.dispose();
    expect(liveEntries()).toBe(base);
  });

  it("dispose aborts in-flight discovery", async () => {
    let seenSignal: AbortSignal | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness("tor12", "root", {
      messages: new Map([["root", [assistant("r1", 0, 2000)]]]),
      listPage: (async (input) => {
        seenSignal = input.signal ?? null;
        await gate;
        return sessionPage([]);
      }) as ListSessionsPage,
    });
    const pending = h.controller.load();
    await tick();
    h.controller.dispose();
    const seen = seenSignal as AbortSignal | null;
    if (seen === null) throw new Error("expected discovery to receive a signal");
    expect(seen.aborted).toBe(true);
    release();
    await pending;
  });

  it("renewal reloads stay within the concurrency bound", async () => {
    const track = { active: 0, peak: 0 };
    const kids = Array.from({ length: 4 }, (_, i) => session(`rc${i}`, "root"));
    const messages = new Map<string, SessionMessageInfo[]>([
      ["root", [assistant("r1", 0, 2000)]],
      ...kids.map((k): [string, SessionMessageInfo[]] => [k.id, [assistant(`${k.id}-m`, 0, 2000)]]),
    ]);
    const childList = new Map([["root", kids]]);
    const h = harness("tor13", "root", {
      children: childList,
      messages,
      concurrency: 2,
      track,
    });
    await h.controller.load();
    expect(track.peak).toBeLessThanOrEqual(2);
    const nextRefs = { client: {}, data: {} };
    const renewed = h.controller.replaceConnection({
      listPage: async ({ parentID }) => sessionPage(childList.get(parentID) ?? []),
      seamForSession: () => ({
        fetchPage: h.fetchPage,
        subscribe: () => () => {},
        isConnected: () => true,
        refs: nextRefs,
      }) as TransportSeam,
      subscribeTree: () => () => {},
      isConnected: () => true,
      refs: nextRefs,
    });
    expect(renewed).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(track.peak).toBeLessThanOrEqual(2);
    expect(h.controller.getState().root.status).toBe("ready");
    h.controller.dispose();
  });

  it("an event burst across children stays within the concurrency bound", async () => {
    const track = { active: 0, peak: 0 };
    const kids = Array.from({ length: 4 }, (_, i) => session(`ec${i}`, "root"));
    const messages = new Map<string, SessionMessageInfo[]>([
      ["root", [assistant("r1", 0, 2000)]],
      ...kids.map((k): [string, SessionMessageInfo[]] => [k.id, [assistant(`${k.id}-m`, 0, 2000)]]),
    ]);
    const h = harness("tor14", "root", {
      children: new Map([["root", kids]]),
      messages,
      concurrency: 2,
      track,
    });
    await h.controller.load();
    track.peak = 0;
    for (const k of kids) h.fire(sessionEvent(k.id));
    await new Promise((r) => setTimeout(r, 100));
    expect(track.peak).toBeLessThanOrEqual(2);
    expect(track.peak).toBeGreaterThan(0);
    h.controller.dispose();
  });

  it("root partial history marks the tree partial without hiding the root", async () => {
    const rootPages = new Map<string, number>();
    const h = harness("tor15", "root", {
      fetchPage: (async (input) => {
        if (input.sessionID !== "root") return msgPage([]);
        // Simulate a looping history cursor: first page then a repeat.
        const n = rootPages.get("root") ?? 0;
        rootPages.set("root", n + 1);
        if (input.cursor === undefined) return msgPage([assistant("r1", 0, 2000)], "loop");
        return msgPage([assistant("r2", 0, 2000)], "loop");
      }) as FetchPage,
    });
    await h.controller.load();
    const state = h.controller.getState();
    expect(state.root.status).toBe("partial");
    expect(state.root.samples.length).toBeGreaterThan(0);
    expect(state.partial).toBe(true);
    expect(state.status).toBe("partial");
    h.controller.dispose();
  });

  it("failed discovery keeps known root and children, marked stale/partial", async () => {
    let failDiscovery = false;
    const childList = new Map([["root", [session("c1", "root"), session("c2", "root")]]]);
    const h = harness("tor16", "root", {
      children: childList,
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
        ["c2", [assistant("k2", 0, 2000)]],
      ]),
      listPage: (async ({ parentID }) => {
        if (failDiscovery) throw new Error("list down");
        return sessionPage(childList.get(parentID) ?? []);
      }) as ListSessionsPage,
    });
    await h.controller.load();
    expect(h.controller.getState().children).toHaveLength(2);
    failDiscovery = true;
    h.controller.refreshAll();
    await new Promise((r) => setTimeout(r, 50));
    const state = h.controller.getState();
    // Previously known scopes survive; the failure is explicit, not silent.
    expect(state.root.status).toBe("ready");
    expect(state.children.map((c) => c.sessionID).sort()).toEqual(["c1", "c2"]);
    expect(state.partial).toBe(true);
    expect(state.error).toMatch(/list down/);
    h.controller.dispose();
  });

  it("partial discovery retains previously known children", async () => {
    let loopCursors = false;
    const childList = new Map([["root", [session("c1", "root"), session("c2", "root")]]]);
    const h = harness("tor17", "root", {
      children: childList,
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
        ["c2", [assistant("k2", 0, 2000)]],
      ]),
      listPage: (async ({ parentID }) => {
        if (!loopCursors) return sessionPage(childList.get(parentID) ?? []);
        // Truncated walk: no usable children, repeated cursor.
        return sessionPage([], "stuck");
      }) as ListSessionsPage,
    });
    await h.controller.load();
    expect(h.controller.getState().children).toHaveLength(2);
    loopCursors = true;
    h.controller.refreshAll();
    await new Promise((r) => setTimeout(r, 50));
    const state = h.controller.getState();
    expect(state.children.map((c) => c.sessionID).sort()).toEqual(["c1", "c2"]);
    expect(state.partial).toBe(true);
    h.controller.dispose();
  });

  it("late old-transport resolutions never publish after renewal", async () => {
    let releaseOld: (v: SessionMessagesResponse) => void = () => undefined;
    const oldGate = new Promise<SessionMessagesResponse>((r) => (releaseOld = r));
    let calls = 0;
    const h = harness("tor18", "root", {
      messages: new Map([["root", [assistant("r1", 0, 2000)]]]),
      fetchPage: (async (input) => {
        calls += 1;
        if (calls === 1) return oldGate;
        return msgPage(h.messages.get(input.sessionID) ?? []);
      }) as FetchPage,
    });
    // Root load starts on the old connection and blocks in its fetch.
    const first = h.controller.load();
    await tick();
    await tick();
    const nextRefs = { client: {}, data: {} };
    const renewed = h.controller.replaceConnection({
      listPage: async ({ parentID }) => sessionPage(h.children.get(parentID) ?? []),
      seamForSession: () => ({
        fetchPage: h.fetchPage,
        subscribe: () => () => {},
        isConnected: () => true,
        refs: nextRefs,
      }) as TransportSeam,
      subscribeTree: () => () => {},
      isConnected: () => true,
      refs: nextRefs,
    });
    expect(renewed).toBe(true);
    // The stale fetch resolves with bogus data after the swap.
    releaseOld(msgPage([assistant("bogus", 0, 1000, 9999)]));
    await first;
    await new Promise((r) => setTimeout(r, 50));
    const state = h.controller.getState();
    expect(state.root.samples.some((s) => s.id === "bogus")).toBe(false);
    expect(state.root.status).toBe("ready");
    expect(state.root.samples.map((s) => s.id)).toEqual(["r1"]);
    h.controller.dispose();
  });

  it("repeated events during a blocked child fetch run at most one repeat", async () => {
    let releaseChild: (v: SessionMessagesResponse) => void = () => undefined;
    const gate = new Promise<SessionMessagesResponse>((r) => (releaseChild = r));
    let gated = true;
    let childCalls = 0;
    const h = harness("tor19", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
      ]),
      fetchPage: (async (input) => {
        if (input.sessionID === "c1") {
          childCalls += 1;
          if (gated) return gate;
        }
        return msgPage(h.messages.get(input.sessionID) ?? []);
      }) as FetchPage,
    });
    const loading = h.controller.load();
    await tick();
    await tick();
    // c1 is blocked in its first fetch; a burst of deltas collapses.
    h.fire(sessionEvent("c1"));
    h.fire(sessionEvent("c1"));
    h.fire(sessionEvent("c1"));
    await tick();
    await tick();
    gated = false;
    releaseChild(msgPage(h.messages.get("c1") ?? []));
    await loading;
    await new Promise((r) => setTimeout(r, 50));
    // Initial fetch plus at most one coalesced repeat, never three.
    expect(childCalls).toBe(2);
    expect(h.controller.getState().children[0]?.snapshot.status).toBe("ready");
    h.controller.dispose();
  });

  it("root metrics arrive while discovery is still blocked", async () => {
    let releaseDiscovery: (v: SessionsResponse) => void = () => undefined;
    const gate = new Promise<SessionsResponse>((r) => (releaseDiscovery = r));
    const h = harness("tor20", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
      ]),
      listPage: (async () => gate) as ListSessionsPage,
    });
    const loading = h.controller.load();
    await tick();
    await tick();
    // Discovery blocked, yet the root scope is already usable.
    expect(h.controller.getState().root.status).toBe("ready");
    expect(h.controller.getState().root.samples.map((s) => s.id)).toEqual(["r1"]);
    releaseDiscovery(sessionPage(h.children.get("root") ?? []));
    await loading;
    expect(h.controller.getState().children.map((c) => c.sessionID)).toEqual(["c1"]);
    h.controller.dispose();
  });

  it("a stale worker never releases the new run's slot (token race)", async () => {
    // Old c1 fetch ignores abort and stays blocked; renewal starts a new
    // run for the same scope; the old fetch resolves with bogus data while
    // the new run is still blocked, with events pending. The stale
    // completion must start nothing, free nothing and publish nothing:
    // exactly one coalesced repeat follows the new run, and the queue
    // keeps serving the other scope in order.
    let releaseOld: (v: SessionMessagesResponse) => void = () => undefined;
    const gateOld = new Promise<SessionMessagesResponse>((r) => (releaseOld = r));
    let releaseNew: (v: SessionMessagesResponse) => void = () => undefined;
    const gateNew = new Promise<SessionMessagesResponse>((r) => (releaseNew = r));
    let childCalls = 0;
    let siblingCalls = 0;
    let rootCalls = 0;
    const h = harness("tor22", "root", {
      children: new Map([["root", [session("c1", "root"), session("c2", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
        ["c2", [assistant("k2", 0, 2000)]],
      ]),
      concurrency: 1,
      fetchPage: (async (input) => {
        if (input.sessionID === "c1") {
          childCalls += 1;
          if (childCalls === 1) return gateOld;
          if (childCalls === 2) return gateNew;
          return msgPage(h.messages.get("c1") ?? []);
        }
        if (input.sessionID === "c2") siblingCalls += 1;
        else rootCalls += 1;
        return msgPage(h.messages.get(input.sessionID) ?? []);
      }) as FetchPage,
    });
    h.controller.load();
    await tick();
    await tick();
    expect(childCalls).toBe(1);
    expect(rootCalls).toBe(1);
    const nextRefs = { client: {}, data: {} };
    let renewedNotify: ((details: OpenCodeEvent) => void) | null = () => undefined;
    expect(
      h.controller.replaceConnection({
        listPage: async ({ parentID }) => sessionPage(h.children.get(parentID) ?? []),
        seamForSession: () => ({
          fetchPage: h.fetchPage,
          subscribe: () => () => {},
          isConnected: () => true,
          refs: nextRefs,
        }) as TransportSeam,
        subscribeTree: (notify) => {
          renewedNotify = notify;
          return () => {
            renewedNotify = null;
          };
        },
        isConnected: () => true,
        refs: nextRefs,
      }),
    ).toBe(true);
    await tick();
    await tick();
    // New generation refetched root once and blocked the new child run;
    // the sibling waits its turn behind it.
    expect(rootCalls).toBe(2);
    expect(childCalls).toBe(2);
    expect(siblingCalls).toBe(0);
    const fireNew = (details: OpenCodeEvent) => renewedNotify?.(details);
    fireNew(sessionEvent("c1"));
    fireNew(sessionEvent("c1"));
    await tick();
    await tick();
    // Stale old fetch resolves with bogus data while the new run blocks:
    // nothing starts, nothing is freed, nothing publishes.
    releaseOld(msgPage([assistant("bogus", 0, 1000, 9999)]));
    await tick();
    await tick();
    expect(childCalls).toBe(2);
    expect(siblingCalls).toBe(0);
    releaseNew(msgPage(h.messages.get("c1") ?? []));
    await new Promise((r) => setTimeout(r, 150));
    // Sibling served in order, then exactly one coalesced repeat.
    expect(siblingCalls).toBe(1);
    expect(childCalls).toBe(3);
    const child = h.controller.getState().children.find((c) => c.sessionID === "c1");
    expect(child?.snapshot.status).toBe("ready");
    expect(child?.snapshot.samples.some((s) => s.id === "bogus")).toBe(false);
    expect(child?.snapshot.samples.map((s) => s.id)).toEqual(["k1"]);
    h.controller.dispose();
  });

  it("root fetches exactly once per full pass with slow discovery", async () => {
    let releaseDiscovery: (v: SessionsResponse) => void = () => undefined;
    const gate = new Promise<SessionsResponse>((r) => (releaseDiscovery = r));
    let rootCalls = 0;
    const h = harness("tor23", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
      ]),
      fetchPage: (async (input) => {
        if (input.sessionID === "root") rootCalls += 1;
        return msgPage(h.messages.get(input.sessionID) ?? []);
      }) as FetchPage,
      listPage: (async () => gate) as ListSessionsPage,
    });
    const loading = h.controller.load();
    await tick();
    await tick();
    expect(rootCalls).toBe(1);
    expect(h.controller.getState().root.status).toBe("ready");
    releaseDiscovery(sessionPage(h.children.get("root") ?? []));
    await loading;
    expect(rootCalls).toBe(1);
    expect(h.controller.getState().children.map((c) => c.sessionID)).toEqual(["c1"]);
    h.controller.dispose();
  });

  it("a child opened as primary keeps live events after tree disposal", async () => {
    const base = liveEntries();
    const h = harness("tor21", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
      ]),
    });
    await h.controller.load();
    expect(h.controller.getState().children).toHaveLength(1);
    // The shared cache holds only the root: children are tree-private.
    expect(liveEntries()).toBe(base + 1);
    // A header elsewhere opens the same child as its primary session: it
    // must build a separate live controller (never reuse a muted seam).
    let headerNotify: (() => void) | null = () => undefined;
    const liveSeam: TransportSeam = {
      fetchPage: h.fetchPage,
      subscribe: (fn: () => void) => {
        headerNotify = fn;
        return () => {
          headerNotify = null;
        };
      },
      isConnected: () => true,
      refs: { client: {}, data: {} },
    };
    let created = false;
    const headerEntry = retainController("tor21", "c1", liveSeam, (transport) => {
      created = true;
      return new SessionMetricsController({
        serverID: "tor21",
        sessionID: "c1",
        transport,
        debounceMs: 0,
      });
    });
    expect(created).toBe(true);
    expect(headerEntry.fresh).toBe(true);
    const unwatch = headerEntry.controller.onUpdate(() => undefined);
    await headerEntry.controller.load();
    const before = h.callsBySession.get("c1") ?? 0;
    headerNotify?.();
    await tick();
    await tick();
    // The header's own events refresh it independently of the tree.
    expect(h.callsBySession.get("c1") ?? 0).toBeGreaterThan(before);
    h.controller.dispose();
    // Tree disposal releases only the root; the header entry survives.
    expect(liveEntries()).toBe(base + 1);
    const during = h.callsBySession.get("c1") ?? 0;
    headerNotify?.();
    await tick();
    await tick();
    expect(h.callsBySession.get("c1") ?? 0).toBeGreaterThan(during);
    unwatch();
    releaseController(headerEntry.key);
    expect(liveEntries()).toBe(base);
  });

  it("suppresses event-only emissions when the selected delegate does not change", async () => {
    const h = harness("tor-perf1", "root", {
      children: new Map([["root", [session("c1", "root"), session("c2", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
        ["c2", [assistant("k2", 0, 2000)]],
      ]),
      debounceMs: 50,
    });
    await h.controller.load();
    const busy = (sid: string, created: number): OpenCodeEvent =>
      ({
        id: `busy-${sid}-${created}`,
        created,
        type: "session.status",
        durable: { aggregateID: "a", seq: 1, version: 1 },
        data: { sessionID: sid, status: { type: "busy" } },
      }) as unknown as OpenCodeEvent;
    const delta = (sid: string, created: number): OpenCodeEvent =>
      ({
        id: `delta-${sid}-${created}`,
        created,
        type: "session.text.delta",
        durable: { aggregateID: "a", seq: 1, version: 1 },
        data: { sessionID: sid, assistantMessageID: "m1", ordinal: 0, delta: "x" },
      }) as unknown as OpenCodeEvent;
    h.fire(busy("c1", 100));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("c1");
    let emissions = 0;
    const unwatch = h.controller.onUpdate(() => emissions += 1);
    // 100 same-active work events advance recency only: no sync snapshot publish.
    for (let i = 1; i <= 100; i += 1) h.fire(delta("c1", 100 + i));
    expect(emissions).toBe(0);
    // A competing verified working child switches selection exactly once, synchronously.
    h.fire(busy("c2", 500));
    expect(emissions).toBe(1);
    expect(h.controller.getActiveDelegateID()).toBe("c2");
    // Event refresh stays coalesced: one debounced pass covers the burst.
    const c1Before = h.callsBySession.get("c1") ?? 0;
    await new Promise((r) => setTimeout(r, 120));
    expect((h.callsBySession.get("c1") ?? 0) - c1Before).toBeLessThanOrEqual(2);
    unwatch();
    h.controller.dispose();
  });

  it("reports an unavailable child with the English fallback and code", async () => {
    const h = harness("tor-en1", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([["root", [assistant("r1", 0, 2000)]]]),
      failMessages: new Set(["c1"]),
    });
    await h.controller.load();
    const state = h.controller.getState();
    expect(state.partial).toBe(true);
    expect(state.error).toBe("subagent c1 unavailable");
    expect(state.errorReason).toEqual({ kind: "child-unavailable", sessionID: "c1" });
    h.controller.dispose();
  });

  it("propagates non-Error discovery failures in English with the code intact", async () => {
    const h = harness("tor-en2", "root", {
      messages: new Map([["root", [assistant("r1", 0, 2000)]]]),
      listPage: async () => {
        throw "boom";
      },
    });
    await h.controller.load();
    const state = h.controller.getState();
    expect(state.partial).toBe(true);
    expect(state.error).toBe("could not read child sessions");
    expect(state.errorReason).toEqual({ kind: "children-unreadable" });
    h.controller.dispose();
  });

  it("surfaces truncated discovery in English while keeping the discovered child", async () => {
    const h = harness("tor-en3", "root", {
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["a", [assistant("k1", 0, 2000)]],
      ]),
      listPage: async () => sessionPage([session("a", "root")], "loop"),
    });
    await h.controller.load();
    const state = h.controller.getState();
    expect(state.partial).toBe(true);
    expect(state.error).toBe("repeated session cursor; tree incomplete");
    expect(state.errorReason).toEqual({ kind: "repeated-session-cursor" });
    expect(state.children.map((c) => c.sessionID)).toEqual(["a"]);
    h.controller.dispose();
  });
});
