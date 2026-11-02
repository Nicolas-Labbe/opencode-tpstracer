import { describe, expect, it, vi } from "vitest";
import type {
  LocationShutdown,
  SessionCreated,
  SessionExecutionFailed,
  SessionExecutionSucceeded,
} from "@opencode/client/promise";
import { readCreatedSession, readEventSessionID, sessionListerFor } from "../src/transport.js";

const durable = { aggregateID: "agg", seq: 1, version: 1 } as const;

describe("readEventSessionID", () => {
  it("reads the session from session-scoped events", () => {
    const ok: SessionExecutionSucceeded = {
      id: "e1",
      created: 1,
      type: "session.execution.succeeded",
      durable,
      data: { sessionID: "ses-1" },
    };
    expect(readEventSessionID(ok)).toBe("ses-1");

    const failed: SessionExecutionFailed = {
      id: "e2",
      created: 2,
      type: "session.execution.failed",
      durable,
      data: { sessionID: "ses-2", error: { type: "unknown", message: "boom" } },
    };
    expect(readEventSessionID(failed)).toBe("ses-2");
  });

  it("returns null for events without session scope", () => {
    const shutdown: LocationShutdown = { id: "e3", created: 3, type: "location.shutdown", data: {} };
    expect(readEventSessionID(shutdown)).toBeNull();
  });
});

describe("readCreatedSession", () => {
  it("reads new session id and parent from creation events", () => {
    const created = {
      id: "e4",
      created: 4,
      type: "session.created",
      durable,
      data: { sessionID: "child-1", parentID: "root-1", projectID: "p" },
    } as unknown as SessionCreated;
    expect(readCreatedSession(created)).toEqual({ sessionID: "child-1", parentID: "root-1" });
  });

  it("yields a null parent for root creations and null for other events", () => {
    const root = {
      id: "e5",
      created: 5,
      type: "session.created",
      durable,
      data: { sessionID: "root-1", projectID: "p" },
    } as unknown as SessionCreated;
    expect(readCreatedSession(root)).toEqual({ sessionID: "root-1", parentID: null });
    const shutdown: LocationShutdown = { id: "e6", created: 6, type: "location.shutdown", data: {} };
    expect(readCreatedSession(shutdown as never)).toBeNull();
  });
});

describe("sessionListerFor", () => {
  it("lists children by parentID with cursor pagination", async () => {
    const list = vi.fn().mockResolvedValue({ data: [], cursor: { previous: null, next: null } });
    const lister = sessionListerFor({ session: { list } } as never);
    await lister({ parentID: "root", limit: 50 });
    expect(list).toHaveBeenCalledWith({ parentID: "root", limit: 50 });
    await lister({ parentID: "root", cursor: "c2", limit: 10 });
    expect(list).toHaveBeenLastCalledWith({ parentID: "root", limit: 10, cursor: "c2" });
  });
});
