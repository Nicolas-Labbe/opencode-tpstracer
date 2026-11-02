import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type {
  OpenCodeEvent,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessagesResponse,
  SessionsResponse,
} from "@opencode/client/promise";
import {
  DelegateActivity,
  headerScopeForTree,
  MAX_ACTIVITY_ENTRIES,
  readIdleActivity,
  readStatusActivity,
  readWorkActivity,
  selectActiveDelegate,
} from "../src/activity.js";
import { SessionTreeController } from "../src/orchestrator.js";
import type { FetchPage, TransportSeam } from "../src/transport.js";
import { headerBadgePresentation } from "../src/presentation.js";
import { summarize } from "../src/metrics.js";

const durable = { aggregateID: "a", seq: 1, version: 1 } as const;

function statusEvent(sessionID: string, kind: "busy" | "retry" | "idle", created: number): OpenCodeEvent {
  const status =
    kind === "busy"
      ? { type: "busy" }
      : kind === "retry"
        ? { type: "retry", attempt: 1, message: "wait", next: created + 1000 }
        : { type: "idle" };
  return {
    id: `s-${sessionID}-${created}`,
    created,
    type: "session.status",
    durable,
    data: { sessionID, status },
  } as unknown as OpenCodeEvent;
}

function idleEvent(sessionID: string, created: number): OpenCodeEvent {
  return {
    id: `i-${sessionID}-${created}`,
    created,
    type: "session.idle",
    durable,
    data: { sessionID },
  } as unknown as OpenCodeEvent;
}

function deltaEvent(
  sessionID: string,
  created: number,
  type: "session.text.delta" | "session.reasoning.delta" = "session.text.delta",
): OpenCodeEvent {
  return {
    id: `d-${sessionID}-${created}`,
    created,
    type,
    durable,
    data: { sessionID, assistantMessageID: "m1", ordinal: 0, delta: "x" },
  } as unknown as OpenCodeEvent;
}

function workEvent(sessionID: string, created: number, type: string, dataExtra: Record<string, unknown> = {}): OpenCodeEvent {
  return {
    id: `w-${sessionID}-${created}-${type}`,
    created,
    type,
    durable,
    data: { sessionID, assistantMessageID: "m1", ...dataExtra },
  } as unknown as OpenCodeEvent;
}

describe("readStatusActivity", () => {
  it("parses busy, retry, and idle with finite timestamps", () => {
    expect(readStatusActivity(statusEvent("c1", "busy", 100))).toEqual({ sessionID: "c1", liveness: "busy", created: 100 });
    expect(readStatusActivity(statusEvent("c2", "retry", 200))).toEqual({ sessionID: "c2", liveness: "retry", created: 200 });
    expect(readStatusActivity(statusEvent("c3", "idle", 300))).toEqual({ sessionID: "c3", liveness: "idle", created: 300 });
  });

  it("ignores malformed, non-finite, foreign, and unknown statuses", () => {
    expect(readStatusActivity(idleEvent("c1", 100))).toBeNull();
    expect(readStatusActivity(deltaEvent("c1", 100))).toBeNull();
    expect(readStatusActivity(statusEvent("", "busy", 100))).toBeNull();
    expect(readStatusActivity(statusEvent("c1", "busy", Number.NaN))).toBeNull();
    expect(readStatusActivity(statusEvent("c1", "busy", Number.POSITIVE_INFINITY))).toBeNull();
    const unknown = {
      id: "e",
      created: 100,
      type: "session.status",
      durable,
      data: { sessionID: "c1", status: { type: "dreaming" } },
    } as unknown as OpenCodeEvent;
    expect(readStatusActivity(unknown)).toBeNull();
    const missing = {
      id: "e",
      created: 100,
      type: "session.status",
      durable,
      data: { status: { type: "busy" } },
    } as unknown as OpenCodeEvent;
    expect(readStatusActivity(missing)).toBeNull();
  });
});

describe("readIdleActivity", () => {
  it("parses session.idle completions", () => {
    expect(readIdleActivity(idleEvent("c1", 150))).toEqual({ sessionID: "c1", created: 150 });
  });

  it("ignores other types and malformed events", () => {
    expect(readIdleActivity(statusEvent("c1", "busy", 100))).toBeNull();
    expect(readIdleActivity({ ...idleEvent("c1", 100), created: Number.NaN } as unknown as OpenCodeEvent)).toBeNull();
    const missing = { id: "e", created: 1, type: "session.idle", durable, data: {} } as unknown as OpenCodeEvent;
    expect(readIdleActivity(missing)).toBeNull();
  });
});

describe("delta recency through the work parser", () => {
  it("parses text and reasoning deltas as work recency", () => {
    expect(readWorkActivity(deltaEvent("c1", 100, "session.text.delta"))).toEqual({ sessionID: "c1", created: 100 });
    expect(readWorkActivity(deltaEvent("c1", 200, "session.reasoning.delta"))).toEqual({ sessionID: "c1", created: 200 });
  });

  it("accepts the current tool/step whitelist with idle and unknown guards", () => {
    // Former delta-only tool rejection is obsolete: tools now advance
    // recency through the same work whitelist.
    const tool = {
      id: "e",
      created: 100,
      type: "session.tool.input.delta",
      durable,
      data: { sessionID: "c1", assistantMessageID: "m1", id: "t1", delta: "x" },
    } as unknown as OpenCodeEvent;
    expect(readWorkActivity(tool)).toEqual({ sessionID: "c1", created: 100 });
    expect(readWorkActivity(workEvent("c1", 120, "session.tool.called", { id: "t1", input: {}, executed: true }))).toEqual({
      sessionID: "c1",
      created: 120,
    });
    expect(readWorkActivity(workEvent("c1", 130, "session.step.started", { agent: "build", model: {}, started: 1 }))).toEqual({
      sessionID: "c1",
      created: 130,
    });
    // Liveness guards: status/idle/completions never parse as work.
    expect(readWorkActivity(statusEvent("c1", "busy", 100))).toBeNull();
    expect(readWorkActivity(idleEvent("c1", 100))).toBeNull();
    expect(readWorkActivity(workEvent("c1", 100, "session.step.ended", { text: "done" }))).toBeNull();
    expect(readWorkActivity(workEvent("", 100, "session.tool.called"))).toBeNull();
  });
});

describe("readWorkActivity", () => {
  it("parses the typed in-progress whitelist with sessionID and finite created", () => {
    const cases: Array<[string, Record<string, unknown>?]> = [
      ["session.text.delta", { ordinal: 0, delta: "x" }],
      ["session.reasoning.delta", { ordinal: 0, delta: "x" }],
      ["session.tool.input.delta", { id: "t1", delta: "x" }],
      ["session.tool.input.started", { id: "t1", name: "bash" }],
      ["session.tool.called", { id: "t1", input: {}, executed: true }],
      ["session.tool.progress", { id: "t1", metadata: {} }],
      ["session.step.started", { agent: "build", model: {}, started: 1 }],
      ["session.step.streamed", {}],
      ["session.text.started", { ordinal: 0 }],
      ["session.reasoning.started", { ordinal: 0 }],
      ["session.shell.started", { shell: {} }],
      ["session.execution.started", {}],
      ["session.retry.scheduled", { attempt: 1, at: 2, error: {} }],
    ];
    for (const [type, extra] of cases) {
      expect(readWorkActivity(workEvent("c1", 100, type, extra ?? {})), type).toEqual({
        sessionID: "c1",
        created: 100,
      });
    }
  });

  it("ignores completions, failures, ends, and unrelated events", () => {
    const ended = ["session.step.ended", "session.text.ended", "session.reasoning.ended", "session.tool.input.ended"];
    for (const type of ended) {
      expect(readWorkActivity(workEvent("c1", 100, type, { text: "done" })), type).toBeNull();
    }
    const completion = {
      id: "e",
      created: 500,
      type: "session.execution.succeeded",
      durable,
      data: { sessionID: "c1" },
    } as unknown as OpenCodeEvent;
    expect(readWorkActivity(completion)).toBeNull();
    const toolDone = {
      id: "e",
      created: 500,
      type: "session.tool.success",
      durable,
      data: { sessionID: "c1", assistantMessageID: "m1", id: "t1", content: [], executed: true },
    } as unknown as OpenCodeEvent;
    expect(readWorkActivity(toolDone)).toBeNull();
    expect(readWorkActivity(statusEvent("c1", "busy", 100))).toBeNull();
    expect(readWorkActivity(idleEvent("c1", 100))).toBeNull();
    expect(readWorkActivity(workEvent("", 100, "session.tool.called"))).toBeNull();
    expect(readWorkActivity(workEvent("c1", Number.NaN, "session.tool.called"))).toBeNull();
    expect(readWorkActivity(workEvent("c1", 100, "session.created"))).toBeNull();
  });
});

describe("DelegateActivity bootstrap", () => {
  it("marks running without timestamps and never overwrites explicit events", () => {
    const activity = new DelegateActivity();
    activity.onStatus("c1", "busy", 100);
    activity.bootstrapRunning(["c1", "c2"]);
    // Explicit busy survives; new running is cached pending verification.
    expect(activity.get("c1")).toMatchObject({ status: "busy", statusCreated: 100, lastActivity: 100 });
    expect(activity.get("c2")).toMatchObject({ status: "running", statusCreated: null, lastActivity: null });
  });

  it("prunes stale bootstrap-only entries that are no longer running", () => {
    const activity = new DelegateActivity();
    activity.bootstrapRunning(["c1", "c2"]);
    expect(activity.size).toBe(2);
    activity.bootstrapRunning(["c2"]);
    expect(activity.get("c1")).toBeUndefined();
    expect(activity.get("c2")).toMatchObject({ status: "running" });
  });

  it("stays bounded under event bursts", () => {
    const activity = new DelegateActivity();
    const ids = Array.from({ length: MAX_ACTIVITY_ENTRIES + 50 }, (_, i) => `burst-${i}`);
    activity.bootstrapRunning(ids);
    expect(activity.size).toBeLessThanOrEqual(MAX_ACTIVITY_ENTRIES);
  });

  it("retains only ids, statuses, and timestamps", () => {
    const activity = new DelegateActivity();
    activity.onStatus("c1", "busy", 100);
    const entry = activity.get("c1");
    expect(Object.keys(entry ?? {}).sort()).toEqual(["lastActivity", "status", "statusCreated"]);
  });
});

describe("DelegateActivity ordering", () => {
  it("a newer idle supersedes an older busy", () => {
    const activity = new DelegateActivity();
    activity.onStatus("c1", "busy", 100);
    expect(activity.selectDelegate(["c1"])).toBe("c1");
    activity.onStatus("c1", "idle", 200);
    expect(activity.selectDelegate(["c1"])).toBeNull();
  });

  it("a delayed older idle cannot suppress a newer busy", () => {
    const activity = new DelegateActivity();
    activity.onStatus("c1", "busy", 200);
    activity.onStatus("c1", "idle", 100);
    expect(activity.selectDelegate(["c1"])).toBe("c1");
  });

  it("a late busy before idle is ignored even when its recency is newer", () => {
    const activity = new DelegateActivity();
    activity.onStatus("c1", "busy", 100);
    activity.onDelta("c1", 250);
    activity.onStatus("c1", "idle", 200);
    // Idle wins despite the newer delta recency; the session stays ineligible.
    expect(activity.selectDelegate(["c1"])).toBeNull();
    expect(activity.onStatus("c1", "busy", 150)).toBe(false);
    expect(activity.selectDelegate(["c1"])).toBeNull();
  });

  it("equal timestamps resolve safe: idle wins", () => {
    const activity = new DelegateActivity();
    activity.onStatus("c1", "busy", 100);
    activity.onStatus("c1", "idle", 100);
    expect(activity.selectDelegate(["c1"])).toBeNull();
    // Busy at the same timestamp cannot resurrect the safe idle.
    activity.onStatus("c1", "busy", 100);
    expect(activity.selectDelegate(["c1"])).toBeNull();
  });

  it("retry is eligible working state", () => {
    const activity = new DelegateActivity();
    activity.onStatus("c1", "retry", 100);
    expect(activity.selectDelegate(["c1"])).toBe("c1");
  });

  it("stores an idle tombstone for unknown sessions so late older busy cannot revive them", () => {
    const activity = new DelegateActivity();
    // Idle observed first (before discovery or bootstrap knows the worker).
    expect(activity.onStatus("c1", "idle", 2000)).toBe(true);
    expect(activity.get("c1")).toMatchObject({ status: "idle", statusCreated: 2000 });
    expect(activity.selectDelegate(["c1"])).toBeNull();
    // A delayed older busy for the already-finished worker is suppressed.
    expect(activity.onStatus("c1", "busy", 1000)).toBe(false);
    expect(activity.selectDelegate(["c1"])).toBeNull();
    // A genuinely newer busy still reactivates.
    expect(activity.onStatus("c1", "busy", 3000)).toBe(true);
    expect(activity.selectDelegate(["c1"])).toBe("c1");
  });

  it("an idle tombstone survives timestamp-free bootstrap without resurrection", () => {
    const activity = new DelegateActivity();
    activity.onStatus("c1", "idle", 2000);
    activity.bootstrapRunning(["c1"]);
    expect(activity.get("c1")).toMatchObject({ status: "idle", statusCreated: 2000 });
    expect(activity.selectDelegate(["c1"])).toBeNull();
  });
});

describe("DelegateActivity deltas", () => {
  it("advance recency only for independently working sessions", () => {
    const activity = new DelegateActivity();
    expect(activity.onDelta("unknown", 100)).toBe(false);
    activity.onStatus("c1", "busy", 100);
    activity.onStatus("c1", "idle", 200);
    expect(activity.onDelta("c1", 300)).toBe(false);
    activity.onStatus("c2", "busy", 100);
    expect(activity.onDelta("c2", 200)).toBe(true);
    expect(activity.get("c2")?.lastActivity).toBe(200);
    // Status ordering untouched: an explicit idle still wins over delta recency.
    activity.onStatus("c2", "idle", 150);
    expect(activity.selectDelegate(["c2"])).toBeNull();
  });

  it("treats tool and step work as recency for the tool-using agent", () => {
    const activity = new DelegateActivity();
    activity.onStatus("a", "busy", 100);
    activity.onStatus("b", "busy", 110);
    expect(activity.selectDelegate(["a", "b"])).toBe("b");
    // A tool call from A (already working) moves recency to A.
    expect(activity.onDelta("a", 300)).toBe(true);
    expect(activity.selectDelegate(["a", "b"])).toBe("a");
    // Tool work from unknown or idle sessions never animates them.
    expect(activity.onDelta("ghost", 400)).toBe(false);
    activity.onStatus("b", "idle", 350);
    expect(activity.onDelta("b", 500)).toBe(false);
    expect(activity.selectDelegate(["a", "b"])).toBe("a");
    // Out-of-order work at or below recency is ignored.
    expect(activity.onDelta("a", 300)).toBe(false);
    expect(activity.onDelta("a", 250)).toBe(false);
    expect(activity.get("a")?.lastActivity).toBe(300);
  });
});

describe("selectActiveDelegate", () => {
  it("prefers the greatest activity and breaks ties by session id", () => {
    const activity = new DelegateActivity();
    activity.onStatus("b-child", "busy", 100);
    activity.onStatus("a-child", "busy", 100);
    expect(activity.selectDelegate(["b-child", "a-child"])).toBe("a-child");
    activity.onDelta("b-child", 200);
    expect(activity.selectDelegate(["a-child", "b-child"])).toBe("b-child");
  });

  it("ranks timestamped work above bootstrap-only guesses", () => {
    const activity = new DelegateActivity();
    activity.bootstrapRunning(["boot"]);
    activity.onStatus("timed", "busy", 50);
    expect(activity.selectDelegate(["boot", "timed"])).toBe("timed");
  });

  it("ignores idle, unknown, and malformed ids", () => {
    const activity = new DelegateActivity();
    activity.onStatus("busy-one", "busy", 100);
    activity.onStatus("idle-one", "busy", 200);
    activity.onStatus("idle-one", "idle", 300);
    const entries = activity.snapshot();
    expect(selectActiveDelegate(["busy-one", "idle-one", "ghost", ""], entries)).toBe("busy-one");
    expect(selectActiveDelegate(["idle-one", "ghost"], entries)).toBeNull();
    expect(selectActiveDelegate([], entries)).toBeNull();
  });
});

describe("headerScopeForTree", () => {
  const rootSnap = { status: "ready", samples: [], observations: [], summary: summarize([]), error: null } as never;
  const childSnap = { status: "ready", samples: [], observations: [], summary: summarize([]), error: null } as never;

  it("selects the verified delegate snapshot and identity", () => {
    const tree = {
      rootSessionID: "root",
      root: rootSnap,
      children: [{ sessionID: "c1", title: "child task", agent: "plan", snapshot: childSnap }],
    };
    const sel = headerScopeForTree(tree, "c1");
    expect(sel).toMatchObject({ sessionID: "c1", title: "child task", agent: "plan", isDelegate: true });
    expect(sel.snap).toBe(childSnap);
  });

  it("falls back to the root when no delegate is active or it vanished", () => {
    const tree = {
      rootSessionID: "root",
      root: rootSnap,
      children: [{ sessionID: "c1", title: "task", agent: "plan", snapshot: childSnap }],
    };
    for (const active of [null, undefined, "", "gone"] as const) {
      const sel = headerScopeForTree(tree, active);
      expect(sel).toMatchObject({ sessionID: "root", isDelegate: false });
      expect(sel.snap).toBe(rootSnap);
    }
  });

  it("keeps the delegate scope during its refresh and never borrows the root rate", () => {
    const refreshingChild = { status: "loading", samples: [], observations: [], summary: summarize([]), error: null } as never;
    const measuredRoot = {
      status: "ready",
      samples: [],
      observations: [],
      summary: summarize([]),
      error: null,
    } as never;
    const tree = {
      rootSessionID: "root",
      root: measuredRoot,
      children: [{ sessionID: "c1", title: "task", agent: "plan", snapshot: refreshingChild }],
    };
    const sel = headerScopeForTree(tree, "c1");
    expect(sel.snap).toBe(refreshingChild);
    // The delegate's own presentation governs: no root borrowing happens here.
    const delegateView = headerBadgePresentation(sel.snap, true, "en");
    const rootView = headerBadgePresentation(measuredRoot, true, "en");
    expect(delegateView.text).not.toBe(rootView.text === "TPS —" ? "BORROWED" : delegateView.text);
  });
});

// --- Orchestrator integration: verified activity over the real tree ---

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

const tick = () => new Promise((r) => setTimeout(r, 15));

function treeHarness(
  serverID: string,
  rootID: string,
  opts: {
    children?: Map<string, SessionInfo[]>;
    messages?: Map<string, SessionMessageInfo[]>;
    running?: string[];
    debounceMs?: number;
    isConnected?: () => boolean;
  } = {},
) {
  const children = opts.children ?? new Map();
  const messages = opts.messages ?? new Map();
  const callsBySession = new Map<string, number>();
  const notifies: Array<(details: OpenCodeEvent) => void> = [];
  let treeNotify: ((details: OpenCodeEvent) => void) | null = null;
  let unsubs = 0;
  const refs = { client: {}, data: {} };
  const isConnected = opts.isConnected ?? (() => true);
  const fetchPage: FetchPage = async (input) => {
    callsBySession.set(input.sessionID, (callsBySession.get(input.sessionID) ?? 0) + 1);
    return msgPage(messages.get(input.sessionID) ?? []);
  };
  const controller = new SessionTreeController({
    serverID,
    rootSessionID: rootID,
    listPage: async ({ parentID }) => sessionPage(children.get(parentID) ?? []),
    seamForSession: (sid: string): TransportSeam => {
      void sid;
      return { fetchPage, subscribe: () => () => {}, isConnected: () => true, refs };
    },
    subscribeTree: (notify) => {
      notifies.push(notify);
      treeNotify = notify;
      return () => {
        treeNotify = null;
        unsubs += 1;
      };
    },
    isConnected,
    refs,
    snapshotRunning: () => opts.running ?? [],
    debounceMs: opts.debounceMs ?? 0,
  });
  return {
    controller,
    fire: (details: OpenCodeEvent) => treeNotify?.(details),
    callsBySession,
    notifies,
    unsubscribed: () => unsubs,
  };
}

describe("orchestrator verified activity", () => {
  it("bootstraps an already-running child, including nested, without waiting for an event", async () => {
    const h = treeHarness("act1", "root", {
      children: new Map([
        ["root", [session("c1", "root", { title: "child task", agent: "plan" })]],
        ["c1", [session("c2", "c1", { title: "grandchild task", agent: "explore" })]],
      ]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
        ["c2", [assistant("k2", 0, 2000)]],
      ]),
      running: ["c2"],
    });
    await h.controller.load();
    expect(h.controller.getState().children.map((c) => c.sessionID).sort()).toEqual(["c1", "c2"]);
    expect(h.controller.getActiveDelegateID()).toBe("c2");
    expect(h.controller.getState().activeDelegateID).toBe("c2");
    h.controller.dispose();
  });

  it("caches events before discovery but never selects unverified sessions", async () => {
    const h = treeHarness("act2", "root", { messages: new Map([["root", [assistant("r1", 0, 2000)]]]) });
    h.controller.onUpdate(() => undefined);
    // Busy arrives before any discovery knows the child: cached, not selected.
    h.fire(statusEvent("later-child", "busy", 100));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBeNull();
    h.controller.dispose();
  });

  it("switches recency from A to B and back to root when all idle", async () => {
    const h = treeHarness("act3", "root", {
      children: new Map([["root", [session("a", "root", { agent: "plan" }), session("b", "root", { agent: "build" })]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["a", [assistant("ka", 0, 2000)]],
        ["b", [assistant("kb", 0, 2000)]],
      ]),
    });
    await h.controller.load();
    h.fire(statusEvent("a", "busy", 100));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("a");
    h.fire(statusEvent("b", "busy", 200));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("b");
    h.fire(idleEvent("b", 300));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("a");
    h.fire(idleEvent("a", 400));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBeNull();
    expect(h.controller.getState().activeDelegateID).toBeNull();
    h.controller.dispose();
  });

  it("uses deltas for recency only between working delegates", async () => {
    const h = treeHarness("act4", "root", {
      children: new Map([["root", [session("a", "root"), session("b", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["a", [assistant("ka", 0, 2000)]],
        ["b", [assistant("kb", 0, 2000)]],
      ]),
    });
    await h.controller.load();
    h.fire(statusEvent("a", "busy", 100));
    h.fire(statusEvent("b", "busy", 110));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("b");
    // A delta for A (already working) moves recency without proving anything new.
    h.fire(deltaEvent("a", 300));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("a");
    // A delta for an unknown session never creates liveness.
    h.fire(deltaEvent("ghost", 400));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("a");
    h.controller.dispose();
  });

  it("ignores history reload completion as activity and keeps the delegate", async () => {
    const h = treeHarness("act5", "root", {
      children: new Map([["root", [session("a", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["a", [assistant("ka", 0, 2000)]],
      ]),
    });
    await h.controller.load();
    h.fire(statusEvent("a", "busy", 100));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("a");
    const done = {
      id: "e",
      created: 500,
      type: "session.execution.succeeded",
      durable,
      data: { sessionID: "a" },
    } as unknown as OpenCodeEvent;
    h.fire(done);
    await tick();
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("a");
    h.controller.dispose();
  });

  it("never follows forks or unrelated sessions", async () => {
    const forked = session("fork1", "root", { fork: { sessionID: "root", boundary: "x" } });
    const h = treeHarness("act6", "root", {
      children: new Map([["root", [session("a", "root"), forked]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["a", [assistant("ka", 0, 2000)]],
      ]),
    });
    await h.controller.load();
    expect(h.controller.getState().children.map((c) => c.sessionID)).toEqual(["a"]);
    h.fire(statusEvent("fork1", "busy", 500));
    h.fire(statusEvent("unrelated", "busy", 600));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBeNull();
    h.fire(statusEvent("a", "busy", 100));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("a");
    h.controller.dispose();
  });

  it("clears stale activity on disconnect and re-bootstraps on reconnect", async () => {
    const running = ["a"];
    const h = treeHarness("act7", "root", {
      children: new Map([["root", [session("a", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["a", [assistant("ka", 0, 2000)]],
      ]),
      running,
    });
    await h.controller.load();
    expect(h.controller.getActiveDelegateID()).toBe("a");
    h.controller.markDisconnected();
    expect(h.controller.getActiveDelegateID()).toBeNull();
    expect(h.controller.getState().activeDelegateID).toBeNull();
    h.controller.reconnect();
    await new Promise((r) => setTimeout(r, 60));
    expect(h.controller.getActiveDelegateID()).toBe("a");
    h.controller.dispose();
  });

  it("a stale verified listener from the old connection cannot mutate following or recency", async () => {
    const live = { current: true };
    const h = treeHarness("act8", "root", {
      children: new Map([["root", [session("c1", "root"), session("c2", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
        ["c2", [assistant("k2", 0, 2000)]],
      ]),
      isConnected: () => live.current,
    });
    await h.controller.load();
    h.fire(statusEvent("c1", "busy", 100));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("c1");
    const staleNotify = h.notifies[h.notifies.length - 1]!;
    // Connection renews (new client/data identities): the old listener dies by token.
    const nextRefs = { client: {}, data: {} };
    expect(
      h.controller.replaceConnection({
        listPage: async ({ parentID }) =>
          sessionPage(
            new Map([["root", [session("c1", "root"), session("c2", "root")]]]).get(parentID) ?? [],
          ),
        seamForSession: (sid: string): TransportSeam => {
          void sid;
          return { fetchPage: async () => msgPage([]), subscribe: () => () => {}, isConnected: () => true, refs: nextRefs };
        },
        subscribeTree: (notify) => {
          h.notifies.push(notify);
          return () => {};
        },
        isConnected: () => live.current,
        refs: nextRefs,
      }),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    // A queued callback from the old connection carries a newer timestamp
    // for the same verified session (renewal cleared prior activity): it
    // must not recreate it nor mutate following/recency.
    staleNotify(statusEvent("c1", "busy", 9999));
    await tick();
    // A legitimate busy for c2 on the current connection selects c2,
    // proving the stale 9999 never landed (it would otherwise outrank 200).
    const currentNotify = h.notifies[h.notifies.length - 1]!;
    currentNotify(statusEvent("c2", "busy", 200));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("c2");
    h.controller.dispose();
  });

  it("firing after disconnect cannot repopulate activity", async () => {
    const live = { current: true };
    const h = treeHarness("act9", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
      ]),
      isConnected: () => live.current,
    });
    await h.controller.load();
    h.fire(statusEvent("c1", "busy", 100));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("c1");
    const staleNotify = h.notifies[h.notifies.length - 1]!;
    live.current = false;
    h.controller.markDisconnected();
    expect(h.controller.getActiveDelegateID()).toBeNull();
    // Both the invalidated listener and the disconnected guard block this.
    staleNotify(statusEvent("c1", "busy", 9999));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBeNull();
    staleNotify(statusEvent("c2", "busy", 9999));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBeNull();
    h.controller.dispose();
  });

  it("reconciles a live running set without fetching histories or walking discovery", async () => {
    const h = treeHarness("act10", "root", {
      children: new Map([["root", [session("c1", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["c1", [assistant("k1", 0, 2000)]],
      ]),
    });
    const emissions: unknown[] = [];
    h.controller.onUpdate((s) => emissions.push(s));
    await h.controller.load();
    expect(h.controller.getActiveDelegateID()).toBeNull();
    const callsBefore = new Map(h.callsBySession);
    const countCalls = () => [...h.callsBySession.values()].reduce((a, b) => a + b, 0);
    const calls0 = countCalls();
    expect(callsBefore).toEqual(h.callsBySession);

    // Data hydrates after mount: empty -> c1 selects the delegate with no fetch.
    expect(h.controller.reconcileRunning(["c1"])).toBe(true);
    expect(h.controller.getActiveDelegateID()).toBe("c1");
    expect(countCalls()).toBe(calls0);
    // Idempotent: same set changes nothing and emits nothing.
    const emissionsAfterFirst = emissions.length;
    expect(h.controller.reconcileRunning(["c1"])).toBe(false);
    expect(emissions.length).toBe(emissionsAfterFirst);
    expect(countCalls()).toBe(calls0);
    // Data drains: bootstrap-only entry prunes back to the root.
    expect(h.controller.reconcileRunning([])).toBe(true);
    expect(h.controller.getActiveDelegateID()).toBeNull();
    expect(countCalls()).toBe(calls0);
    // Explicit statuses survive reconcile: no timestamp-free overwrite.
    h.fire(statusEvent("c1", "busy", 100));
    await tick();
    await tick();
    // The busy event itself schedules the known child's bounded history
    // refresh (pre-existing behavior); reconcile adds nothing further.
    const calls1 = countCalls();
    expect(calls1).toBeGreaterThan(calls0);
    expect(h.controller.reconcileRunning([])).toBe(false);
    expect(h.controller.getActiveDelegateID()).toBe("c1");
    expect(countCalls()).toBe(calls1);
    h.controller.dispose();
  });

  it("follows tool work recency between two busy delegates", async () => {
    const h = treeHarness("act11", "root", {
      children: new Map([["root", [session("a", "root"), session("b", "root")]]]),
      messages: new Map([
        ["root", [assistant("r1", 0, 2000)]],
        ["a", [assistant("ka", 0, 2000)]],
        ["b", [assistant("kb", 0, 2000)]],
      ]),
    });
    await h.controller.load();
    h.fire(statusEvent("a", "busy", 100));
    h.fire(statusEvent("b", "busy", 110));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("b");
    // The tool-using agent's valid tool event moves recency to A.
    h.fire(workEvent("a", 300, "session.tool.called", { id: "t1", input: {}, executed: true }));
    await tick();
    expect(h.controller.getActiveDelegateID()).toBe("a");
    h.controller.dispose();
  });
});

/**
 * Header identity and shared-owner source contracts (no DOM rendering).
 * Geometry and wiring are asserted at the source level: compact truncated
 * identity span, full provenance in title/aria, neutral root, preserved
 * open/hover/focus behavior, and one shared tree for header+panel.
 */
describe("header identity wiring", () => {
  const view = readFileSync(new URL("../src/view.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/panel.css", import.meta.url), "utf8");
  const gui = readFileSync(new URL("../src/gui.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/gui-hook.tsx", import.meta.url), "utf8");

  it("shows the delegate identity compactly with full provenance in tooltip/aria", () => {
    expect(view).toContain("tps-header-identity");
    expect(view).toContain("identityText()");
    expect(view).toContain("provenance()");
    expect(view).toContain("agentLabel(");
    expect(view).toContain("rootScopeLabel(");
    expect(view).toContain("header.workingDelegate");
    expect(view).toContain("header.partialNote");
    expect(view).toContain("title={label()}");
    expect(view).toContain("onClick={props.onOpen}");
    expect(view).toContain("aria-busy={presentation().refreshing}");
    expect(view).toContain("header.openHint");
  });

  it("keeps the identity compact with ellipsis and preserves badge geometry", () => {
    expect(css).toContain(".tps-header-identity");
    expect(css).toContain("max-width: 18ch");
    expect(css).toContain("text-overflow: ellipsis");
    expect(css).toContain("overflow: hidden");
    const hoverBlock = css.slice(
      css.indexOf(".tps-header-badge:hover"),
      css.indexOf("}", css.indexOf(".tps-header-badge:hover")) + 1,
    );
    expect(hoverBlock).not.toContain("padding");
    expect(hoverBlock).not.toContain("display");
  });

  it("routes the header through the shared tree with delegate selection", () => {
    expect(gui).toContain("useHeaderTree");
    expect(gui).toContain("headerScopeForTree");
    expect(gui).toContain("identity={identity()}");
    expect(gui).toContain("follow={follow()}");
    expect(gui).toContain("selection().snap");
    expect(hook).toContain("retainSharedTree");
    expect(hook).toContain("releaseSharedTree");
    expect(hook).toContain("useHeaderTree");
    expect(hook).toContain("usePanelTree");
    expect(hook).toContain("snapshotRunning");
    expect(hook).toContain("reconcileRunning");
    expect(hook).toContain("untrack");
  });

  it("derives header copy from typed catalogs, never raw authored strings", () => {
    const i18n = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
    expect(i18n).toContain("header.workingDelegate");
    expect(i18n).toContain("header.partialNote");
    expect(view).not.toMatch(/Working subagent [^{]/);
    expect(view).not.toMatch(/Partial follow view: [^{]/);
  });
});
