/**
 * Live push to the operator screen.
 *
 * Server-sent events over the existing HTTP port. No Redis, no queue service --
 * a second thing to power, monitor and repair at a post that may not have
 * mains electricity, in exchange for nothing this needs.
 */

export type StreamMessage =
  | { type: "event"; data: unknown }
  | { type: "incident"; data: unknown }
  | { type: "action"; data: unknown }
  | { type: "camera"; data: unknown }
  | { type: "hello"; data: unknown };

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

/** An SSE response the browser can hold open. */
export function streamResponse(): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream({
    start(controller) {
      const send = (message: StreamMessage) => {
        controller.enqueue(
          encoder.encode(`event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`),
        );
      };

      send({ type: "hello", data: { at: new Date().toISOString() } });
      unsubscribe = subscribe(send);

      // Keeps proxies from closing an idle connection on a quiet night.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          /* closed underneath us; cancel() cleans up */
        }
      }, 20_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // The console is served from its own port, so the stream needs this too.
      // Without it EventSource is rejected and the screen goes quietly stale --
      // which curl never reveals, because curl does not enforce CORS.
      "access-control-allow-origin": "*",
    },
  });
}
