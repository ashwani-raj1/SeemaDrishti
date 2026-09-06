/**
 * The live overlay channel: raw detections, straight from the vision service.
 *
 * One socket for the whole app, multiplexed by camera id -- the same reasoning
 * as lib/stream.ts holding one EventSource. Four tiles would otherwise open
 * four sockets to one process for no gain, and browsers cap connections per
 * host anyway.
 *
 * THIS IS NOT THE RECORD. Boxes are ephemeral: never stored, never replayed,
 * worthless the moment nobody is looking at the tile. What survives is what
 * the fence decided about them, which arrives over lib/stream.ts as events and
 * incidents. Two channels because they have nothing in common but a
 * destination -- different rates, different durability, different meanings.
 *
 * If this channel dies the video keeps playing and the record keeps recording.
 * That independence is the reason the channels were split in the first place,
 * so this file must never become a dependency of either.
 */

export interface Box {
  track_ref: string;
  class: string;
  confidence: number;
  /** [x, y, w, h], normalised 0..1, top-left origin. */
  bbox: [number, number, number, number];
}

export interface BoxFrame {
  camera_id: string;
  capture_mono: number;
  boxes: Box[];
}

export type BoxState = "connecting" | "live" | "down";

type Listener = (frame: BoxFrame) => void;

const listeners = new Map<string, Set<Listener>>();
const stateListeners = new Set<(state: BoxState) => void>();

let socket: WebSocket | null = null;
let state: BoxState = "connecting";
let retry: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let url = "";

function setState(next: BoxState) {
  if (state === next) return;
  state = next;
  for (const fn of stateListeners) fn(next);
}

export const boxState = () => state;

export function onBoxState(fn: (state: BoxState) => void): () => void {
  stateListeners.add(fn);
  fn(state);
  return () => stateListeners.delete(fn);
}

/**
 * Subscribe to one camera's boxes.
 *
 * Filtering happens here rather than server-side because at four cameras the
 * whole channel is a few KB/s. The socket does support narrowing (the vision
 * service accepts a subscribe message) and that becomes worth sending when a
 * console shows one tile out of sixteen.
 */
export function onBoxes(cameraId: string, fn: Listener): () => void {
  let set = listeners.get(cameraId);
  if (!set) listeners.set(cameraId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(cameraId);
  };
}

export function connectBoxes(wsUrl: string): () => void {
  url = wsUrl;
  open();
  return () => {
    if (retry) clearTimeout(retry);
    retry = null;
    socket?.close();
    socket = null;
  };
}

function open() {
  if (!url || socket) return;
  setState("connecting");

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleRetry();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    attempts = 0;
    setState("live");
  };

  ws.onmessage = (raw) => {
    let message: { t?: string } & Partial<BoxFrame>;
    try {
      message = JSON.parse(raw.data as string);
    } catch {
      return; // a malformed frame must not take the overlay down
    }
    if (message.t !== "boxes" || !message.camera_id) return;
    const frame = message as BoxFrame;
    for (const fn of listeners.get(frame.camera_id) ?? []) fn(frame);
  };

  ws.onerror = () => setState("down");

  ws.onclose = () => {
    socket = null;
    setState("down");
    scheduleRetry();
  };
}

/**
 * Backing off matters here: the vision service is the process most likely to
 * be restarting (it is the one doing the risky work), and a console hammering
 * it once a second while it loads four YOLO models would take CPU from the
 * thing it is waiting for.
 */
function scheduleRetry() {
  if (retry || !url) return;
  const delay = Math.min(1000 * 2 ** attempts, 15_000);
  attempts += 1;
  retry = setTimeout(() => {
    retry = null;
    open();
  }, delay);
}
