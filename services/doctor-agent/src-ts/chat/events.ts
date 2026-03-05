import type { Request, Response } from "express";
import { appendChatEvent, ChatEvent, listChatEvents } from "./session-store.js";

const subscribers = new Map<string, Set<Response>>();

function sseChunk(event: ChatEvent): string {
  const payload = JSON.stringify({
    id: event.id,
    sessionId: event.sessionId,
    type: event.eventType,
    data: event.payload,
    createdAt: event.createdAt
  });
  return `id: ${event.id}\nevent: ${event.eventType}\ndata: ${payload}\n\n`;
}

function writeEvent(res: Response, event: ChatEvent): void {
  res.write(sseChunk(event));
}

export function publishChatEvent(input: {
  sessionId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}): ChatEvent {
  const event = appendChatEvent(input);
  const listeners = subscribers.get(input.sessionId);
  if (listeners && listeners.size > 0) {
    for (const listener of listeners) {
      writeEvent(listener, event);
    }
  }
  return event;
}

export function streamChatEvents(input: {
  req: Request;
  res: Response;
  sessionId: string;
  since?: string;
}): void {
  const { req, res, sessionId, since } = input;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  res.write(": connected\n\n");

  const replay = listChatEvents({ sessionId, since, limit: 500 });
  for (const event of replay) {
    writeEvent(res, event);
  }

  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15000);

  const set = subscribers.get(sessionId) ?? new Set<Response>();
  set.add(res);
  subscribers.set(sessionId, set);

  req.on("close", () => {
    clearInterval(keepalive);
    const listeners = subscribers.get(sessionId);
    if (!listeners) {
      return;
    }
    listeners.delete(res);
    if (listeners.size === 0) {
      subscribers.delete(sessionId);
    }
  });
}
