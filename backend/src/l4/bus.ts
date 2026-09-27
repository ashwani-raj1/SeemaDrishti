/**
 * Live push to the operator screen.
 *
 * Server-sent events over the existing HTTP port. No Redis, no queue service --
 * a second thing to power, monitor and repair at a post that may not have
 * mains electricity, in exchange for nothing this needs.
 */
import type { Request, Response } from "express";

export type StreamMessage =
  | { type: "event"; data: unknown }
  | { type: "incident"; data: unknown }
  | { type: "action"; data: unknown }
  | { type: "camera"; data: unknown }
  | { type: "watchlist_change"; data: unknown }
  | { type: "plate_detection"; data: unknown }
  | { type: "hello"; data: unknown }
  | { type: "heartbeat"; data: unknown };

type Subscriber = (message: StreamMessage) => void;

const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function publish(message: StreamMessage): void {
  for (const fn of subscribers) {
    try {
      fn(message);
    } catch {
      // A dead browser tab must never take down the analysis path.
      subscribers.delete(fn);
    }
  }
}

export const subscriberCount = (): number => subscribers.size;

/** Hold an SSE stream open on this response until the browser goes away. */
export function streamTo(req: Request, res: Response): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const send = (message: StreamMessage) => {
    res.write(`event: ${message.type}
data: ${JSON.stringify(message.data)}

`);
  };

  send({ type: "hello", data: { at: new Date().toISOString() } });
  const unsubscribe = subscribe(send);

  // A NAMED event, not an SSE comment.
  //
  // A comment keeps the socket open but fires no listener in EventSource,
  // so a screen watching for silence cannot see it -- which made a healthy
  // stream look dead on exactly the quiet nights it should reassure
  // through. This is observable, so the console can tell "quiet" from
  // "gone". It also keeps intermediaries from closing an idle connection.
  const heartbeat = setInterval(() => {
    try {
      send({ type: "heartbeat", data: { at: new Date().toISOString() } });
    } catch {
      /* closed underneath us; the close handler cleans up */
    }
  }, 15_000);

  req.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
}
