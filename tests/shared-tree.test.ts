import { describe, expect, it } from "vitest";
import type {
  OpenCodeEvent,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessagesResponse,
  SessionsResponse,
} from "@opencode/client/promise";
import { SessionTreeController, type TreeControllerOptions } from "../src/orchestrator.js";
import { liveTreeEntries, releaseSharedTree, retainSharedTree } from "../src/shared-tree.js";
import type { FetchPage, TransportSeam } from "../src/transport.js";

function assistant(id: string): SessionMessageAssistant {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "acme", id: "fast" },
    content: [],
    tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, completed: 2000 },
    finish: "stop",
  };
}

function session(id: string, parentID?: string): SessionInfo {
  return {
    id,
    projectID: "proj",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/tmp" },
    ...(parentID !== undefined ? { parentID } : {}),
  } as SessionInfo;
}

function msgPage(messages: SessionMessageInfo[]): SessionMessagesResponse {
  return { data: messages, cursor: { previous: null, next: null } };
}

function sessionPage(data: SessionInfo[]): SessionsResponse {
  return { data, cursor: { previous: null, next: null } };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const durable = { aggregateID: "a", seq: 1, version: 1 } as const;

function statusEvent(sessionID: string, created: number): OpenCodeEvent {
  return {
    id: `s-${sessionID}-${created}`,
    created,
    type: "session.status",
    durable,
    data: { sessionID, status: { type: "busy" } },
  } as unknown as OpenCodeEvent;
}

interface TreeHarness {
  callsBySession: Map<string, number>;
  notifies: Array<(details: OpenCodeEvent) => void>;
  readonly unsubs: number;
  refs: { readonly client: unknown; readonly data: unknown };
  fetchPage: FetchPage;
  optionsFor: (extra?: Partial<TreeControllerOptions>) => TreeControllerOptions;
}

function treeHarness(
  serverID: string,
  rootID: string,
  opts: {
    children?: Map<string, SessionInfo[]>;
    messages?: Map<string, SessionMessageInfo[]>;
    running?: string[];
    refs?: { readonly client: unknown; readonly data: unknown };
  } = {},
): TreeHarness {
  const children = opts.children ?? new Map();
  const messages = opts.messages ?? new Map();
  const callsBySession = new Map<string, number>();
  const notifies: Array<(details: OpenCodeEvent) => void> = [];
  let unsubs = 0;
  const refs = opts.refs ?? { client: {}, data: {} };
  const running = opts.running ?? [];
  const fetchPage: FetchPage = async (input) => {
    callsBySession.set(input.sessionID, (callsBySession.get(input.sessionID) ?? 0) + 1);
    return msgPage(messages.get(input.sessionID) ?? []);
  };
  const optionsFor = (extra: Partial<TreeControllerOptions> = {}): TreeControllerOptions => ({
    serverID,
    rootSessionID: rootID,
    listPage: async ({ parentID }) => sessionPage(children.get(parentID) ?? []),
    seamForSession: (sid: string): TransportSeam => {
      void sid;
      return { fetchPage, subscribe: () => () => {}, isConnected: () => true, refs };
    },
    subscribeTree: (notify) => {
      notifies.push(notify);
      return () => {
        unsubs += 1;
      };
    },
    isConnected: () => true,
    refs,
    snapshotRunning: () => running,
    debounceMs: 0,
    ...extra,
  });
  return {
    callsBySession,
    notifies,
    get unsubs() {
      return unsubs;
    },
    refs,
    fetchPage,
    optionsFor,
  };
}

describe("shared tree ownership", () => {
  it("shares one tree between header and panel without duplicate work", async () => {
    const base = liveTreeEntries();
    const h = treeHarness("shr1", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1")]],
        ["c1", [assistant("k1")]],
      ]),
    });
    const first = retainSharedTree("shr1", "root", h.optionsFor());
    expect(first.fresh).toBe(true);
    const states: unknown[] = [];
    const unwatch = first.tree.onUpdate((s) => states.push(s));
    await first.tree.load();
    const rootCalls = h.callsBySession.get("root") ?? 0;
    expect(rootCalls).toBeGreaterThan(0);
    expect(liveTreeEntries()).toBe(base + 1);

    // Second consumer (panel) attaches the same key: same instance, no reload.
    const second = retainSharedTree("shr1", "root", h.optionsFor());
    expect(second.fresh).toBe(false);
    expect(second.tree).toBe(first.tree);
    expect(liveTreeEntries()).toBe(base + 1);
    await tick();
    expect(h.callsBySession.get("root") ?? 0).toBe(rootCalls);

    unwatch();
    releaseSharedTree(first.key);
    // Panel closed: header's tree survives with live state.
    expect(liveTreeEntries()).toBe(base + 1);
    expect(first.tree.getState().root.status).toBe("ready");
    releaseSharedTree(second.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("isolates roots and servers", async () => {
    const base = liveTreeEntries();
    const a = treeHarness("shr2", "root-a", { messages: new Map([["root-a", [assistant("ra")]]]) });
    const b = treeHarness("shr2", "root-b", { messages: new Map([["root-b", [assistant("rb")]]]) });
    const c = treeHarness("shr3", "root-a", { messages: new Map([["root-a", [assistant("rc")]]]) });
    const ea = retainSharedTree("shr2", "root-a", a.optionsFor());
    const eb = retainSharedTree("shr2", "root-b", b.optionsFor());
    const ec = retainSharedTree("shr3", "root-a", c.optionsFor());
    expect(liveTreeEntries()).toBe(base + 3);
    expect(new Set([ea.tree, eb.tree, ec.tree]).size).toBe(3);
    await ea.tree.load();
    await eb.tree.load();
    await ec.tree.load();
    expect(ea.tree.getState().rootSessionID).toBe("root-a");
    expect(eb.tree.getState().rootSessionID).toBe("root-b");
    expect(ec.tree.serverID).toBe("shr3");
    releaseSharedTree(ea.key);
    releaseSharedTree(eb.key);
    releaseSharedTree(ec.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("renewal with new transport clears stale activity and re-bootstraps", async () => {
    const base = liveTreeEntries();
    const children = new Map([["root", [session("old", "root"), session("fresh", "root")]]]);
    const messages = new Map([
      ["root", [assistant("r1")]],
      ["old", [assistant("ko")]],
      ["fresh", [assistant("kf")]],
    ]);
    const firstRefs = { client: {}, data: {} };
    const h1 = treeHarness("shr4", "root", { children, messages, running: ["old"], refs: firstRefs });
    const entry = retainSharedTree("shr4", "root", h1.optionsFor());
    await entry.tree.load();
    entry.tree.onUpdate(() => undefined);
    // Old delegate working.
    const fireFirst = (details: OpenCodeEvent) => h1.notifies[h1.notifies.length - 1]?.(details);
    void fireFirst;
    // Drive activity through the tree subscription path used by the hook.
    const directHarness = entry.tree;
    expect(directHarness.getState().activeDelegateID).toBe("old");

    // Server restart: new client/data identities with a different live set.
    const nextRefs = { client: {}, data: {} };
    const h2 = treeHarness("shr4", "root", { children, messages, running: ["fresh"], refs: nextRefs });
    const second = retainSharedTree("shr4", "root", h2.optionsFor({ refs: nextRefs }));
    expect(second.tree).toBe(entry.tree);
    await new Promise((r) => setTimeout(r, 80));
    // Stale "old" work is gone; the fresh connection's running delegate follows.
    expect(entry.tree.getActiveDelegateID()).toBe("fresh");
    expect(entry.tree.getState().activeDelegateID).toBe("fresh");
    releaseSharedTree(entry.key);
    releaseSharedTree(second.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("stale subscriptions cannot publish after renewal", async () => {
    const base = liveTreeEntries();
    const children = new Map([["root", [session("c1", "root"), session("c2", "root")]]]);
    const messages = new Map([
      ["root", [assistant("r1")]],
      ["c1", [assistant("k1")]],
      ["c2", [assistant("k2")]],
    ]);
    const h = treeHarness("shr5", "root", { children, messages });
    const entry = retainSharedTree("shr5", "root", h.optionsFor());
    await entry.tree.load();
    const fireCurrent = (details: OpenCodeEvent) => h.notifies[h.notifies.length - 1]?.(details);
    fireCurrent(statusEvent("c1", 100));
    await tick();
    expect(entry.tree.getActiveDelegateID()).toBe("c1");
    const staleNotify = h.notifies[h.notifies.length - 1]!;
    const unsubsBefore = h.unsubs;

    const nextRefs = { client: {}, data: {} };
    const h2 = treeHarness("shr5", "root", { children, messages, refs: nextRefs });
    retainSharedTree("shr5", "root", h2.optionsFor({ refs: nextRefs }));
    // Renewal invalidated the old listener exactly once.
    expect(h.unsubs).toBe(unsubsBefore + 1);
    await new Promise((r) => setTimeout(r, 80));
    // A queued old-connection callback with a newer timestamp for the
    // same verified session must not recreate following or recency.
    staleNotify(statusEvent("c1", 9999));
    await tick();
    // The current connection's legitimate busy for c2 wins, proving the
    // stale 9999 never landed (it would otherwise outrank 200).
    const fireRenewed = (details: OpenCodeEvent) => h2.notifies[h2.notifies.length - 1]?.(details);
    fireRenewed(statusEvent("c2", 200));
    await tick();
    expect(entry.tree.getActiveDelegateID()).toBe("c2");
    releaseSharedTree(entry.key);
    releaseSharedTree(entry.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("disconnect clears the delegate and reconnect re-bootstraps the live connection", async () => {
    const base = liveTreeEntries();
    const h = treeHarness("shr6", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1")]],
        ["c1", [assistant("k1")]],
      ]),
      running: ["c1"],
    });
    const entry = retainSharedTree("shr6", "root", h.optionsFor());
    await entry.tree.load();
    expect(entry.tree.getActiveDelegateID()).toBe("c1");
    entry.tree.markDisconnected();
    expect(entry.tree.getActiveDelegateID()).toBeNull();
    entry.tree.reconnect();
    await new Promise((r) => setTimeout(r, 80));
    expect(entry.tree.getActiveDelegateID()).toBe("c1");
    releaseSharedTree(entry.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("a deferred root fetch cannot publish ready after disconnect; reconnect recovers", async () => {
    const base = liveTreeEntries();
    let releaseRoot!: (v: SessionMessagesResponse) => void;
    const rootGate = new Promise<SessionMessagesResponse>((r) => (releaseRoot = r));
    let rootCalls = 0;
    const children = new Map([["root", [session("c1", "root")]]]);
    const messages = new Map([
      ["root", [assistant("r1")]],
      ["c1", [assistant("k1")]],
    ]);
    const h = treeHarness("shr8", "root", { children, messages });
    const gatedFetch: FetchPage = async (input) => {
      if (input.sessionID === "root") {
        rootCalls += 1;
        if (rootCalls === 1) return rootGate;
      }
      return msgPage(messages.get(input.sessionID) ?? []);
    };
    const entry = retainSharedTree(
      "shr8",
      "root",
      h.optionsFor({
        seamForSession: (sid: string): TransportSeam => {
          void sid;
          return { fetchPage: gatedFetch, subscribe: () => () => {}, isConnected: () => true, refs: h.refs };
        },
      }),
    );
    const loading = entry.tree.load();
    await tick();
    await tick();
    // Root fetch blocked in flight; disconnect marks every owned scope,
    // including the shared root, without disposing sibling consumers.
    const { liveEntries } = await import("../src/shared.js");
    const sharedBefore = liveEntries();
    entry.tree.markDisconnected();
    expect(entry.tree.getState().status).toBe("disconnected");
    expect(entry.tree.getState().root.status).toBe("disconnected");
    expect(liveEntries()).toBe(sharedBefore);
    releaseRoot(msgPage([assistant("r1")]));
    await loading;
    await tick();
    // The stale resolution never flips the tree back to ready.
    expect(entry.tree.getState().status).toBe("disconnected");
    expect(entry.tree.getState().root.status).toBe("disconnected");
    expect(entry.tree.getState().root.samples).toHaveLength(0);
    entry.tree.reconnect();
    await new Promise((r) => setTimeout(r, 80));
    expect(entry.tree.getState().root.status).toBe("ready");
    expect(entry.tree.getState().root.samples.map((s) => s.id)).toEqual(["r1"]);
    releaseSharedTree(entry.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("reuses the shared root controller and never disposes a sibling consumer", async () => {
    const base = liveTreeEntries();
    const h = treeHarness("shr7", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1")]],
        ["c1", [assistant("k1")]],
      ]),
    });
    const header = retainSharedTree("shr7", "root", h.optionsFor());
    const panel = retainSharedTree("shr7", "root", h.optionsFor());
    await header.tree.load();
    const tree: SessionTreeController = header.tree;
    void tree;
    // Children are tree-private: only the shared root lives in the shared cache.
    const { liveEntries } = await import("../src/shared.js");
    expect(liveEntries()).toBeGreaterThanOrEqual(1);
    releaseSharedTree(panel.key);
    // Header still reads ready root metrics after the panel leaves.
    expect(header.tree.getState().root.status).toBe("ready");
    releaseSharedTree(header.key);
    expect(liveTreeEntries()).toBe(base);
  });
});

describe("ported binding lifecycle via shared tree", () => {
  it("attaches and loads on first retain", async () => {
    const base = liveTreeEntries();
    const h = treeHarness("port1", "s1", { messages: new Map([["s1", [assistant("a")]]]) });
    const entry = retainSharedTree("port1", "s1", h.optionsFor());
    expect(entry.fresh).toBe(true);
    const states: unknown[] = [];
    const unwatch = entry.tree.onUpdate((s) => states.push(s));
    await entry.tree.load();
    expect(entry.tree.getState().root.status).toBe("ready");
    expect(entry.tree.getState().root.samples.map((s) => s.id)).toEqual(["a"]);
    expect(states.length).toBeGreaterThan(0);
    expect(liveTreeEntries()).toBe(base + 1);
    unwatch();
    releaseSharedTree(entry.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("same key with same refs neither reloads nor resubscribes", async () => {
    const base = liveTreeEntries();
    const h = treeHarness("port2", "s1", { messages: new Map([["s1", [assistant("a")]]]) });
    const first = retainSharedTree("port2", "s1", h.optionsFor());
    await first.tree.load();
    const rootCalls = h.callsBySession.get("s1") ?? 0;
    expect(rootCalls).toBeGreaterThan(0);
    const unsubsBefore = h.unsubs;
    const second = retainSharedTree("port2", "s1", h.optionsFor());
    expect(second.fresh).toBe(false);
    expect(second.tree).toBe(first.tree);
    await tick();
    expect(h.callsBySession.get("s1") ?? 0).toBe(rootCalls);
    expect(h.unsubs).toBe(unsubsBefore);
    releaseSharedTree(first.key);
    releaseSharedTree(second.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("same key with new refs renews transport and reloads", async () => {
    const base = liveTreeEntries();
    const firstRefs = { client: {}, data: {} };
    const h1 = treeHarness("port3", "s1", {
      messages: new Map([["s1", [assistant("v1")]]]),
      refs: firstRefs,
    });
    const entry = retainSharedTree("port3", "s1", h1.optionsFor());
    await entry.tree.load();
    expect(entry.tree.getState().root.samples.map((s) => s.id)).toEqual(["v1"]);
    const unsubsBefore = h1.unsubs;
    const nextRefs = { client: {}, data: {} };
    const h2 = treeHarness("port3", "s1", {
      messages: new Map([["s1", [assistant("v2")]]]),
      refs: nextRefs,
    });
    const second = retainSharedTree("port3", "s1", h2.optionsFor({ refs: nextRefs }));
    expect(second.tree).toBe(entry.tree);
    expect(second.fresh).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(h1.unsubs).toBe(unsubsBefore + 1);
    expect(h2.callsBySession.get("s1") ?? 0).toBeGreaterThan(0);
    expect(entry.tree.getState().root.status).toBe("ready");
    expect(entry.tree.getState().root.samples.map((s) => s.id)).toEqual(["v2"]);
    releaseSharedTree(entry.key);
    releaseSharedTree(second.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("a moving consumer never redirects the staying consumer", async () => {
    const base = liveTreeEntries();
    const refsA = { client: {}, data: {} };
    const hA = treeHarness("port4a", "s1", {
      messages: new Map([["s1", [assistant("a-msg")]]]),
      refs: refsA,
    });
    const panel = retainSharedTree("port4a", "s1", hA.optionsFor());
    const header = retainSharedTree("port4a", "s1", hA.optionsFor());
    await panel.tree.load();
    expect(liveTreeEntries()).toBe(base + 1);
    expect(panel.tree.getState().root.samples.map((s) => s.id)).toEqual(["a-msg"]);
    // Header moves to another server/root: release old share, retain new.
    releaseSharedTree(header.key);
    const hB = treeHarness("port4b", "s9", { messages: new Map([["s9", [assistant("b-msg")]]]) });
    const headerMoved = retainSharedTree("port4b", "s9", hB.optionsFor());
    await headerMoved.tree.load();
    expect(liveTreeEntries()).toBe(base + 2);
    expect(panel.tree.getState().root.status).toBe("ready");
    expect(panel.tree.getState().root.samples.map((s) => s.id)).toEqual(["a-msg"]);
    expect(headerMoved.tree.getState().root.samples.map((s) => s.id)).toEqual(["b-msg"]);
    // Server A restarts: only the staying consumer reloads via its own seam.
    const bCallsBefore = hB.callsBySession.get("s9") ?? 0;
    const renewedRefs = { client: {}, data: {} };
    const hA2 = treeHarness("port4a", "s1", {
      messages: new Map([["s1", [assistant("a-msg")]]]),
      refs: renewedRefs,
    });
    const panelRenewed = retainSharedTree("port4a", "s1", hA2.optionsFor({ refs: renewedRefs }));
    expect(panelRenewed.tree).toBe(panel.tree);
    await new Promise((r) => setTimeout(r, 80));
    expect(hA2.callsBySession.get("s1") ?? 0).toBeGreaterThan(0);
    expect(hB.callsBySession.get("s9") ?? 0).toBe(bCallsBefore);
    expect(panel.tree.getState().root.samples.map((s) => s.id)).toEqual(["a-msg"]);
    releaseSharedTree(panel.key);
    releaseSharedTree(panelRenewed.key);
    releaseSharedTree(headerMoved.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("disconnect without any event shows disconnected and drops late responses", async () => {
    const base = liveTreeEntries();
    let releaseRoot!: (v: SessionMessagesResponse) => void;
    const rootGate = new Promise<SessionMessagesResponse>((r) => (releaseRoot = r));
    let rootCalls = 0;
    const messages = new Map([["s1", [assistant("r1")]]]);
    const h = treeHarness("port5", "s1", { messages });
    const gatedFetch: FetchPage = async (input) => {
      if (input.sessionID === "s1") {
        rootCalls += 1;
        if (rootCalls === 1) return rootGate;
      }
      return msgPage(messages.get(input.sessionID) ?? []);
    };
    const entry = retainSharedTree(
      "port5",
      "s1",
      h.optionsFor({
        seamForSession: (sid: string): TransportSeam => {
          void sid;
          return { fetchPage: gatedFetch, subscribe: () => () => {}, isConnected: () => true, refs: h.refs };
        },
      }),
    );
    const loading = entry.tree.load();
    await tick();
    await tick();
    expect(rootCalls).toBe(1);
    entry.tree.markDisconnected();
    expect(entry.tree.getState().status).toBe("disconnected");
    expect(entry.tree.getState().root.status).toBe("disconnected");
    releaseRoot(msgPage([assistant("late")]));
    await loading;
    await tick();
    expect(entry.tree.getState().status).toBe("disconnected");
    expect(entry.tree.getState().root.status).toBe("disconnected");
    expect(entry.tree.getState().root.samples).toHaveLength(0);
    expect(rootCalls).toBe(1);
    releaseSharedTree(entry.key);
    expect(liveTreeEntries()).toBe(base);
  });

  it("reconnect takes a fresh snapshot", async () => {
    const base = liveTreeEntries();
    const h = treeHarness("port6", "s1", { messages: new Map([["s1", [assistant("a")]]]) });
    const entry = retainSharedTree("port6", "s1", h.optionsFor());
    await entry.tree.load();
    expect(entry.tree.getState().root.status).toBe("ready");
    const callsBefore = h.callsBySession.get("s1") ?? 0;
    entry.tree.markDisconnected();
    expect(entry.tree.getState().status).toBe("disconnected");
    entry.tree.reconnect();
    await new Promise((r) => setTimeout(r, 80));
    expect(h.callsBySession.get("s1") ?? 0).toBeGreaterThan(callsBefore);
    expect(entry.tree.getState().root.status).toBe("ready");
    expect(entry.tree.getState().root.samples.map((s) => s.id)).toEqual(["a"]);
    releaseSharedTree(entry.key);
    expect(liveTreeEntries()).toBe(base);
  });
});
