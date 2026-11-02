import { describe, expect, it, vi } from "vitest";
import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessageUser,
  SessionMessagesResponse,
} from "@opencode/client/promise";
import { SessionMetricsController } from "../src/adapter.js";
import type { FetchPage, TransportSeam } from "../src/transport.js";

function assistant(
  id: string,
  created: number,
  completed: number,
  output = 100,
  extra: Partial<SessionMessageAssistant> = {},
): SessionMessageAssistant {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "acme", id: "fast" },
    content: [],
    tokens: { input: 10, output, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, completed },
    finish: "stop",
    ...extra,
  };
}

function page(messages: SessionMessageInfo[], next: string | null): SessionMessagesResponse {
  return { data: messages, cursor: { previous: null, next } };
}

function userMessage(id: string): SessionMessageUser {
  return { id, type: "user", time: { created: 0 }, text: "hello" };
}

/** Test seam over our own interface; payloads use the real SDK response type. */
function seam(
  fetchPage: FetchPage,
  opts: { connected?: boolean; refs?: { client: unknown; data: unknown }; onSubscribe?: () => void } = {},
): TransportSeam & { fire: () => void } {
  let notify: (() => void) | null = null;
  const refs = opts.refs ?? { client: {}, data: {} };
  return {
    fetchPage,
    subscribe: (fn: () => void) => {
      opts.onSubscribe?.();
      notify = fn;
      return () => {
        notify = null;
      };
    },
    isConnected: () => opts.connected ?? true,
    refs,
    fire: () => notify?.(),
  };
}

function controller(
  transport: TransportSeam,
  opts: { serverID?: string; sessionID?: string; safetyPageCap?: number; debounceMs?: number } = {},
): SessionMetricsController {
  return new SessionMetricsController({
    serverID: opts.serverID ?? "s",
    sessionID: opts.sessionID ?? "s1",
    transport,
    safetyPageCap: opts.safetyPageCap,
    debounceMs: opts.debounceMs ?? 0,
  });
}

describe("SessionMetricsController", () => {
  it("paginates and dedupes by message id", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([assistant("a", 0, 2000), assistant("b", 0, 4000)], "c2"))
      .mockResolvedValueOnce(page([assistant("b", 0, 4000), assistant("c", 0, 2000)], null));
    const c = controller(seam(fetchPage));
    await c.load();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(c.getState().status).toBe("ready");
    expect(c.getState().samples.map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
    // 300 output tokens over 8s => 37.5 weighted
    expect(c.getState().summary.weightedTps).toBe(37.5);
    c.dispose();
  });

  it("loads more than 20 pages completely (old 20-page cap regression)", async () => {
    const fetchPage = vi.fn(async (input: { cursor?: string }) => {
      const n = input.cursor === undefined ? 0 : Number(input.cursor);
      const last = n === 24;
      return page([assistant(`m${n}`, n * 1000, n * 1000 + 1000)], last ? null : String(n + 1));
    });
    const c = controller(seam(fetchPage));
    await c.load();
    expect(fetchPage).toHaveBeenCalledTimes(25);
    expect(c.getState().status).toBe("ready");
    expect(c.getState().samples).toHaveLength(25);
    c.dispose();
  });

  it("reports partial (never ready) on a repeated cursor", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([assistant("a", 0, 1000)], "b"))
      .mockResolvedValue(page([assistant("b", 0, 1000)], "b")); // server loops on "b"
    const c = controller(seam(fetchPage));
    await c.load();
    expect(c.getState().status).toBe("partial");
    expect(c.getState().error).toMatch(/cursor/i);
    // Loaded pages are still shown, explicitly marked incomplete.
    expect(c.getState().samples.map((s) => s.id).sort()).toEqual(["a", "b"]);
    c.dispose();
  });

  it("reports partial when the safety page cap is hit with pages remaining", async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => {
      n += 1;
      return page([assistant(`m${n}`, 0, 1000)], `page-${n}`);
    });
    const c = controller(seam(fetchPage), { safetyPageCap: 2 });
    await c.load();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(c.getState().status).toBe("partial");
    expect(c.getState().error).toMatch(/truncat/i);
    c.dispose();
  });

  it("keeps only assistant messages and computes weighted TPS", async () => {
    const fetchPage = vi.fn().mockResolvedValue(
      page([userMessage("u1"), assistant("a", 0, 2000, 100), assistant("b", 0, 8000, 100)], null),
    );
    const c = controller(seam(fetchPage));
    await c.load();
    expect(c.getState().summary.weightedTps).toBe(20);
    c.dispose();
  });

  it("excludes finish:error responses without an error object", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValue(page([assistant("bad", 0, 1000, 500, { finish: "error" })], null));
    const c = controller(seam(fetchPage));
    await c.load();
    expect(c.getState().status).toBe("empty");
    c.dispose();
  });

  it("reports empty when no valid samples", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([userMessage("u")], null));
    const c = controller(seam(fetchPage));
    await c.load();
    expect(c.getState().status).toBe("empty");
    c.dispose();
  });

  it("reports errors without throwing", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new Error("offline"));
    const c = controller(seam(fetchPage));
    await c.load();
    expect(c.getState().status).toBe("error");
    expect(c.getState().error).toBe("offline");
    c.dispose();
  });

  it("uses the session server key and ignores stale responses", async () => {
    let firstResolve!: (v: SessionMessagesResponse) => void;
    const first = new Promise<SessionMessagesResponse>((r) => (firstResolve = r));
    const fetchPage = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(page([], null));
    const c = controller(seam(fetchPage), { serverID: "srv-a", sessionID: "sess-1" });
    expect(c.key).toBe("srv-a\nsess-1");
    const pending = c.load();
    c.reconnect(); // newer generation starts second load
    firstResolve(page([assistant("stale", 0, 1000, 9999)], null));
    await pending;
    await new Promise((r) => setTimeout(r, 10));
    // Stale 9999-token payload must not leak into state.
    expect(c.getState().samples.some((s) => s.id === "stale")).toBe(false);
    c.dispose();
  });

  it("drops late responses after cancel()", async () => {
    let resolve!: (v: SessionMessagesResponse) => void;
    const pending = new Promise<SessionMessagesResponse>((r) => (resolve = r));
    const fetchPage = vi.fn().mockReturnValue(pending);
    const c = controller(seam(fetchPage));
    const loading = c.load();
    c.cancel();
    resolve(page([assistant("late", 0, 1000, 9999)], null));
    await loading;
    expect(c.getState().samples).toHaveLength(0);
    expect(c.getState().status).not.toBe("error");
    c.dispose();
  });

  it("coalesces rapid refresh triggers into one reload", async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn().mockResolvedValue(page([], null));
    const c = controller(seam(fetchPage), { debounceMs: 50 });
    c.requestRefresh();
    c.requestRefresh();
    c.requestRefresh();
    await vi.advanceTimersByTimeAsync(60);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    c.dispose();
    vi.useRealTimers();
  });

  it("reloads on subscribed events without counting payloads", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([assistant("a", 0, 2000)], null));
    const t = seam(fetchPage);
    const c = controller(t);
    await c.load();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    t.fire(); // delta-style event: schedules a history reload, counts nothing
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(c.getState().summary.weightedTps).toBe(50);
    c.dispose();
  });

  it("reports disconnected without fetching", async () => {
    const fetchPage = vi.fn();
    const c = controller(seam(fetchPage, { connected: false }));
    await c.load();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(c.getState().status).toBe("disconnected");
    c.dispose();
  });

  it("cleans up timer, inflight request and subscription", async () => {
    const unsubscribe = vi.fn();
    const fetchPage = vi.fn(
      () =>
        new Promise<SessionMessagesResponse>((_, reject) => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }),
    );
    const t = seam(fetchPage);
    const c = controller({ ...t, subscribe: () => unsubscribe });
    c.requestRefresh();
    c.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("replaceTransport is a no-op for the same connection", async () => {
    const refs = { client: {}, data: {} };
    const fetchPage = vi.fn().mockResolvedValue(page([], null));
    const c = controller(seam(fetchPage, { refs }));
    await c.load();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    const renewed = c.replaceTransport(seam(fetchPage, { refs }));
    expect(renewed).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("replaceTransport re-subscribes and reloads on a new connection", async () => {
    const unsubOld = vi.fn();
    const unsubNew = vi.fn();
    const fetchPage = vi.fn().mockResolvedValue(page([assistant("a", 0, 2000)], null));
    const c = controller({
      ...seam(fetchPage, { refs: { client: { v: 1 }, data: { v: 1 } } }),
      subscribe: () => unsubOld,
    });
    await c.load();
    const renewed = c.replaceTransport({
      ...seam(fetchPage, { refs: { client: { v: 2 }, data: { v: 1 } } }),
      subscribe: () => unsubNew,
    });
    expect(renewed).toBe(true);
    expect(unsubOld).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(c.getState().status).toBe("ready");
    c.dispose();
    expect(unsubNew).toHaveBeenCalledTimes(1);
  });

  it("replaceTransport with reload:false still drops late old-transport results", async () => {
    let resolveOld!: (v: SessionMessagesResponse) => void;
    const oldGate = new Promise<SessionMessagesResponse>((r) => (resolveOld = r));
    const fetchOld = vi.fn().mockReturnValue(oldGate);
    const c = controller(seam(fetchOld, { refs: { client: { v: 1 }, data: {} } }));
    const first = c.load();
    await new Promise((r) => setTimeout(r, 5));
    const fetchNew = vi.fn().mockResolvedValue(page([assistant("fresh", 0, 2000)], null));
    const renewed = c.replaceTransport(seam(fetchNew, { refs: { client: { v: 2 }, data: {} } }), {
      reload: false,
    });
    expect(renewed).toBe(true);
    // The stale fetch resolves with bogus data after the swap: dropped.
    resolveOld(page([assistant("stale", 0, 1000, 9999)], null));
    await first;
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchNew).not.toHaveBeenCalled();
    expect(c.getState().samples.some((s) => s.id === "stale")).toBe(false);
    expect(c.getState().status).toBe("loading");
    c.dispose();
  });
});
