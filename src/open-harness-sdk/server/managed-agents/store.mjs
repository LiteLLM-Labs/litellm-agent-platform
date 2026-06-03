// store.mjs — in-memory session records + per-session event history with live
// pub/sub fan-out. Pure Node, no deps.
import { genId, nowIso } from "./core.mjs";

/** Session records keyed by id. */
export function createSessionStore() {
  const sessions = new Map();
  return {
    create({ agent }) {
      const session = {
        id: genId("session"),
        object: "session",
        agent,
        status: "idle",
        created_at: nowIso(),
      };
      sessions.set(session.id, session);
      return session;
    },
    get(id) {
      return sessions.get(id);
    },
    setStatus(id, status) {
      const s = sessions.get(id);
      if (s) s.status = status;
    },
    delete(id) {
      return sessions.delete(id);
    },
  };
}

/** Per-session event history + live subscriber fan-out. */
export function createEventStore() {
  /** @type {Map<string, { history: object[], subscribers: Set<Function> }>} */
  const sessions = new Map();

  function getOrCreate(sessionId) {
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = { history: [], subscribers: new Set() };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  return {
    /** Stamp id/session_id/created_at onto a bare event, store it, broadcast. */
    publish(sessionId, bareEvent) {
      const stamped = {
        id: genId("evt"),
        session_id: sessionId,
        created_at: nowIso(),
        ...bareEvent,
      };
      const entry = getOrCreate(sessionId);
      entry.history.push(stamped);
      for (const listener of entry.subscribers) {
        try {
          listener(stamped);
        } catch {
          // one bad subscriber must not break the rest of the broadcast
        }
      }
      return stamped;
    },

    /** Stored events in insertion order, or [] if none. */
    list(sessionId) {
      const entry = sessions.get(sessionId);
      return entry ? entry.history.slice() : [];
    },

    /** Register a listener for events published AFTER this call; returns unsubscribe(). */
    subscribe(sessionId, listener) {
      const entry = getOrCreate(sessionId);
      entry.subscribers.add(listener);
      return function unsubscribe() {
        entry.subscribers.delete(listener);
      };
    },

    /** Drop all history + subscribers for a session. */
    deleteSession(sessionId) {
      sessions.delete(sessionId);
    },
  };
}
