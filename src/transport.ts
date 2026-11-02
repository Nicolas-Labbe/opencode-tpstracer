/**
 * Host transport wiring for TPSTracer.
 *
 * Binds the framework-free adapter seam to one captured server connection
 * using the real published SDK types (`OpenCodeClient`, `Data`,
 * `OpenCodeEvent` from `@opencode/client@2.2.0`). No structural stand-ins:
 * every accessed member is checked against the installed contract at
 * compile time.
 */

import type { Data } from "@opencode/client/solid";
import type {
  MessageListInput,
  OpenCodeClient,
  OpenCodeEvent,
  SessionListInput,
  SessionMessagesResponse,
  SessionsResponse,
} from "@opencode/client/promise";

export type FetchPageInput = Pick<MessageListInput, "sessionID" | "cursor" | "limit"> & {
  readonly signal?: AbortSignal;
};

export type FetchPage = (input: FetchPageInput) => Promise<SessionMessagesResponse>;

/** Returns an unsubscribe function. Payload-free: any call means "reload". */
export type Subscribe = (notify: () => void) => () => void;

/**
 * Adapter seam pinned to one captured server connection. Renewal is explicit
 * (`refs` identity): a restarted server yields new client/data objects and
 * the consumer builds a fresh seam instead of reading a moved route.
 */
export interface TransportSeam {
  readonly fetchPage: FetchPage;
  readonly subscribe: Subscribe;
  readonly isConnected: () => boolean;
  /** Opaque identity of the pinned connection for renewal detection. */
  readonly refs: { readonly client: unknown; readonly data: unknown };
}

/**
 * Read the session a host event belongs to, from the verified union shape:
 * session-scoped events carry `data: { sessionID: SessionID; ... }`
 * (e.g. `session.execution.succeeded`, `session.message.content.updated`).
 * Events without that shape yield null and never trigger a reload.
 */
export function readEventSessionID(details: OpenCodeEvent): string | null {
  if (typeof details !== "object" || details === null) return null;
  if (!("data" in details)) return null;
  const data: unknown = details.data;
  if (typeof data !== "object" || data === null) return null;
  if (!("sessionID" in data)) return null;
  const id: unknown = data.sessionID;
  return typeof id === "string" ? id : null;
}

/**
 * Build a seam from one captured connection. `client`/`data` are read from
 * the same capture for the seam's lifetime; renewal requires a new seam.
 */
export function seamFor(
  client: OpenCodeClient,
  data: Data,
  isConnected: () => boolean,
  sessionID: string,
): TransportSeam {
  return {
    fetchPage: (input) =>
      client.message.list(
        { sessionID: input.sessionID, cursor: input.cursor, limit: input.limit ?? 100, type: "assistant" },
        { signal: input.signal },
      ),
    subscribe: (notify) =>
      data.listen((event) => {
        // Any matching event only schedules a reload; payloads (including
        // text/reasoning deltas) are never counted as tokens.
        if (readEventSessionID(event.details) === sessionID) notify();
      }),
    isConnected,
    refs: { client, data },
  };
}

/** Paginated child-session listing bound to one captured server client. */
export type ListSessionsPage = (input: {
  readonly parentID: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}) => Promise<SessionsResponse>;

/** Build a child-session lister from one captured server client. */
export function sessionListerFor(client: OpenCodeClient): ListSessionsPage {
  return (input) => {
    const listInput: SessionListInput = {
      parentID: input.parentID,
      limit: input.limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    };
    return input.signal !== undefined
      ? client.session.list(listInput, { signal: input.signal })
      : client.session.list(listInput);
  };
}

/**
 * Read a `session.created` event's identity: the new session id plus its
 * optional parent. Non-creation events yield null and never trigger
 * discovery; payloads are routing hints only, never metrics.
 */
export function readCreatedSession(details: OpenCodeEvent): {
  readonly sessionID: string;
  readonly parentID: string | null;
} | null {
  if (typeof details !== "object" || details === null) return null;
  if (!("data" in details) || !("type" in details)) return null;
  if (details.type !== "session.created") return null;
  const data: unknown = details.data;
  if (typeof data !== "object" || data === null) return null;
  if (!("sessionID" in data)) return null;
  const sessionID: unknown = data.sessionID;
  if (typeof sessionID !== "string" || sessionID.length === 0) return null;
  const parentRaw: unknown = "parentID" in data ? data.parentID : null;
  return {
    sessionID,
    parentID: typeof parentRaw === "string" && parentRaw.length > 0 ? parentRaw : null,
  };
}
