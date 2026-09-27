/**
 * One EventSource for the whole app.
 *
 * One per component would open four streams for four mounted sections and make
 * the node's own `streamSubscribers` count a lie. Sections subscribe here.
 */
import { apiUrl } from "./api";

export type StreamKind =
  | "event" | "incident" | "action" | "camera" | "hello"
  | "plate_detection" | "watchlist_change" | "person_watchlist_change" | "vehicle_traffic";

/** Observed to prove the stream is alive, never dispatched to sections. */
const HEARTBEAT = "heartbeat";

/**
 * Whether the live push is actually alive. A stream that has quietly died
 * looks exactly like a quiet night -- which is the failure #17 exists to
 * prevent, so it is surfaced rather than assumed.
 */
export type StreamState = "connecting" | "live" | "down";

type Listener = (data: unknown) => void;

const listeners = new Map<StreamKind, Set<Listener>>();
const stateListeners = new Set<(state: StreamState) => void>();

let source: EventSource | null = null;
let state: StreamState = "connecting";
/** The node beats every 15s; silence well past that means gone, not quiet. */
let lastBeat = Date.now();

const KINDS: StreamKind[] = [
  "event", "incident", "action", "camera", "hello",
  "plate_detection", "watchlist_change", "person_watchlist_change", "vehicle_traffic",
];
const STALE_AFTER_MS = 45_000;

function setState(next: StreamState) {
  if (state === next) return;
  state = next;
  for (const fn of stateListeners) fn(next);
}

export const streamState = () => state;

export function onStreamState(fn: (state: StreamState) => void): () => void {
  stateListeners.add(fn);
  fn(state);
  return () => stateListeners.delete(fn);
}

export function onStream(kind: StreamKind, fn: Listener): () => void {
  let set = listeners.get(kind);
  if (!set) listeners.set(kind, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

export function connectStream(): () => void {
  if (source) return () => {};

  setState("connecting");
  source = new EventSource(apiUrl("/api/stream"));

  source.onopen = () => {
    lastBeat = Date.now();
    setState("live");
  };
  source.onerror = () => setState("down");

  // The beat is what separates "nothing is happening" from "nothing is
  // getting through". It carries no payload, so nothing subscribes to it.
  source.addEventListener(HEARTBEAT, () => {
    lastBeat = Date.now();
    setState("live");
  });

  for (const kind of KINDS) {
    source.addEventListener(kind, (raw) => {
      lastBeat = Date.now();
      setState("live");
      let data: unknown = null;
      try {
        data = JSON.parse((raw as MessageEvent).data);
      } catch {
        return; // a malformed frame must not take the screen down
      }
      for (const fn of listeners.get(kind) ?? []) fn(data);
    });
  }

  // EventSource reports a dropped socket, but not a socket held open by a
  // proxy with nothing coming down it. The heartbeat gap catches that.
  const watchdog = setInterval(() => {
    if (Date.now() - lastBeat > STALE_AFTER_MS) setState("down");
  }, 5_000);

  return () => {
    clearInterval(watchdog);
    source?.close();
    source = null;
    setState("connecting");
  };
}
