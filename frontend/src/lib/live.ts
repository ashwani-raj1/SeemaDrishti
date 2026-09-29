/**
 * The live observation channel: what each detection module is seeing, now.
 *
 * One socket for the whole app, multiplexed by camera AND module -- the same
 * reasoning as lib/stream.ts holding one EventSource. A console showing four
 * tiles would otherwise open four sockets to one process for no gain, and
 * browsers cap connections per host anyway.
 *
 * THIS IS NOT THE RECORD. Observations are ephemeral: never stored, never
 * replayed, worthless the moment nobody is looking. What survives is what the
 * edge node decided about them, which arrives over lib/stream.ts as events and
 * incidents. Two channels because they have nothing in common but a
 * destination -- different rates, different durability, different meanings.
 *
 * If this channel dies the video keeps playing and the record keeps recording.
 * That independence is why the channels were split, so this file must never
 * become a dependency of either.
 *
 * WHY PER-MODULE AND NOT ONE BOX LIST: the fence page wants pending crossings
 * and zone sides; the ANPR page wants live plate guesses; the people page wants
 * trajectories. Those live in each module's `extra`, and a single merged box
 * stream would have to flatten them into one shape that suits none of the three.
 * The vision service already sends them apart (vision-service/core/payload.py); this
 * keeps them apart all the way to the component that draws them.
 */

/** One tracked subject, as one module currently sees it. */
export interface LiveTrack {
  track_id: number | null;
  /** [x1, y1, x2, y2], normalised 0..1, top-left origin. */
  bbox: [number, number, number, number];
  confidence: number;
  class: string;
  /** Module-specific and UNCONFIRMED. Draw it; never act on it. */
  extra: Record<string, unknown>;
}

export interface LiveObservation {
  camera_id: string;
  module: string;
  kind: "live";
  /** Producer-monotonic seconds. Only differences are meaningful. */
  frame_ts: number;
  tracks: LiveTrack[];
}

/** What the fence module puts in `extra`. Narrow on purpose. */
export interface FenceExtra {
  track_ref?: string;
  ground?: [number, number];
  trail?: Array<[number, number]>;
  zones?: Array<{
    zone_id: string;
    name: string;
    side: number;
    pending: boolean;
    held: number;
    direction: string | null;
  }>;
}

/** What the anpr module puts in `extra`. */
export interface AnprExtra {
  track_ref?: string;
  vehicle_type?: string;
  image_snapshot?: string | null;
  plate?: {
    text: string;
    confidence: number;
    bbox: [number, number, number, number];
    source?: "ocr" | "llm";
    model?: string | null;
    /** Always false on this channel. The accepted read comes from the node. */
    confirmed: boolean;
    image_snapshot?: string | null;
  };
}

/** What the face module puts in `extra`. Detection only -- never identity. */
export interface FaceExtra {
  track_ref?: string;
  face?: {
    /** [x1, y1, x2, y2], normalised 0..1 -- same convention as the track box. */
    bbox: [number, number, number, number];
    score: number;
  };
  /**
   * Set when this track matched a person_watchlist entry -- computed by
   * modules/watchlist_client.py against the backend's list, face signal
   * preferred over appearance (see that module's own docstring). Unlike
   * `face` above, THIS is an identity claim, and every alertable durable
   * event it produces is also recorded server-side (backend/src/l3/
   * person_watchlist.ts), so a match is never something only this live
   * overlay ever knew about.
   */
  watchlist_match?: {
    name: string;
    score: number;
    signal: "face" | "appearance";
  } | null;
  /**
   * Raw cosine similarity against the operator's current one-off target
   * search (backend/src/l3/target.ts, modules/target_client.py), or absent
   * when nobody has set one. UNCONFIRMED on purpose, same as `face` above:
   * this is appearance-only colour matching, never a face or a name, and
   * the viewer decides what counts as "found" (people.tsx's own
   * TARGET_MATCH_THRESHOLD) -- this field is never gated on a threshold
   * before it reaches here.
   */
  target_score?: number | null;
}

/** What the multi_human module puts in `extra`. */
export interface PeopleExtra {
  track_ref?: string;
  /**
   * The module's own stable label ("P1", "P2", ...) -- one per
   * appearance-matched span of tracks, not one per ByteTrack id. Persists
   * across a short occlusion or a full re-entry that the reid provider
   * matched; see modules/reid.py's naming rule for what this label does and
   * does not claim (colour-based re-association, never recognition).
   */
  person_id?: string;
  ground?: [number, number];
  /** The identity's FULL trail (module-side `trail_limit`, default unbounded
   * for a bounded demo clip) -- one continuous line across the whole span
   * `person_id` covers, including straight across an occlusion gap. */
  trail?: Array<[number, number]>;
  age_seconds?: number;
}

/** One camera, as the vision service currently reports it. */
export interface VisionCameraStatus {
  camera_id: string;
  modules: string[];
  simulated: boolean;
  feed: "live" | "down";
  frames: number;
  fps: number;
  detector_ms: number;
  detector_calls: number;
  drop_rate: number | null;
  reconnects: number | null;
}

/**
 * The vision service saying it is alive, and what it is managing.
 *
 * WHY THIS EXISTS: observations only arrive when a camera produces frames, so
 * an empty screen could mean a quiet border or a crashed detector. Without a
 * heartbeat the console cannot tell those apart -- which is the exact silent
 * capability loss this whole system is meant to prevent.
 */
export interface VisionStatus {
  kind: "status";
  run_id: string;
  uptime_s: number;
  cameras: VisionCameraStatus[];
  durable: { sent: number; failed: number; shed: number; queued: number } | null;
  /** Set by this client, not the wire: when the message arrived. */
  receivedAt: number;
}

export type LiveState = "connecting" | "live" | "down";

type Listener = (observation: LiveObservation) => void;

/** Keyed `camera/module`, or `camera/*` for every module on that camera. */
const listeners = new Map<string, Set<Listener>>();
const stateListeners = new Set<(state: LiveState) => void>();
const statusListeners = new Set<(status: VisionStatus) => void>();
let lastStatus: VisionStatus | null = null;

let socket: WebSocket | null = null;
let state: LiveState = "connecting";
let retry: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let url = "";

function setState(next: LiveState) {
  if (state === next) return;
  state = next;
  for (const fn of stateListeners) fn(next);
}

export const liveState = () => state;

export function onLiveState(fn: (state: LiveState) => void): () => void {
  stateListeners.add(fn);
  fn(state);
  return () => stateListeners.delete(fn);
}

/**
 * Subscribe to one camera's observations, optionally from one module only.
 *
 * Filtering happens here rather than server-side because at a handful of
 * cameras the whole channel is a few KB/s. The socket does support narrowing
 * (the vision service accepts a `subscribe` message) and that becomes worth
 * sending when a console shows one tile out of sixteen.
 */
export function onLive(
  cameraId: string,
  module: string | null,
  fn: Listener,
): () => void {
  const key = `${cameraId}/${module ?? "*"}`;
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(key);
  };
}

/**
 * Subscribe to the service-level heartbeat.
 *
 * Replays the last one immediately so a screen mounting between beats shows
 * the truth rather than "unknown" for up to two seconds.
 */
export function onVisionStatus(fn: (status: VisionStatus) => void): () => void {
  statusListeners.add(fn);
  if (lastStatus) fn(lastStatus);
  return () => statusListeners.delete(fn);
}

export const visionStatus = () => lastStatus;

export function connectLive(wsUrl: string): () => void {
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
    // Widened on purpose: this socket carries observations, the service
    // heartbeat and a `hello`. Typing it as only an observation made the
    // status discriminant unreachable.
    let message: Omit<Partial<LiveObservation>, "kind"> & { kind?: string; t?: string };
    try {
      message = JSON.parse(raw.data as string);
    } catch {
      return; // a malformed frame must not take the overlay down
    }
    if (message.kind === "status") {
      lastStatus = { ...(message as unknown as VisionStatus), receivedAt: Date.now() };
      for (const fn of statusListeners) fn(lastStatus);
      return;
    }

    // The service also sends a `hello` on connect. Anything that is not a live
    // observation by here is not ours.
    if (message.kind !== "live" || !message.camera_id || !message.module) return;

    const observation = message as LiveObservation;
    for (const key of [
      `${observation.camera_id}/${observation.module}`,
      `${observation.camera_id}/*`,
    ]) {
      for (const fn of listeners.get(key) ?? []) fn(observation);
    }
  };

  ws.onerror = () => setState("down");

  ws.onclose = () => {
    socket = null;
    setState("down");
    // Forget the last heartbeat. Keeping it would leave a green "vision
    // service up" card on screen after the process died -- the precise lie
    // this heartbeat exists to prevent.
    lastStatus = null;
    scheduleRetry();
  };
}

/**
 * Backing off matters here: the vision service is the process most likely to be
 * restarting (it is the one doing the risky work), and a console hammering it
 * once a second while it loads a YOLO model per camera would take CPU from the
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
