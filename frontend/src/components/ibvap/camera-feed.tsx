/**
 * One camera's live picture, with a module's observations drawn on it.
 *
 * Three independent sources compose this tile, and keeping them independent is
 * the whole design:
 *
 *   video   WHEP, hub -> browser        lib/whep.ts
 *   tracks  WS, vision -> browser       lib/live.ts      ephemeral
 *   zones   /api/config                 static until edited
 *
 * None of them can take the others down. The detector restarting freezes the
 * boxes and leaves the picture live; the edge node restarting touches neither.
 * The tile says which parts are working rather than showing a plausible-looking
 * still and letting somebody assume the rest is fine -- a screen that has
 * quietly stopped updating is the failure this whole console exists to prevent.
 *
 * ONE MODULE AT A TIME, by default. Each service page draws its own module's
 * view: the fence page wants pending crossings, the ANPR page wants plate
 * guesses. Passing `module={null}` merges every module's tracks, which is what
 * a general camera tile wants and what no service page should ask for.
 *
 * OVERLAY ALIGNMENT IS BEST-EFFORT. WebRTC frame timestamps and detection
 * timestamps come from different clocks; the latest tracks are drawn over the
 * current frame without reconciling them. On a walking person the error is not
 * visible. Frame-accurate alignment needs a detection ring buffer keyed on
 * capture time and requestVideoFrameCallback, and is deliberately not built --
 * note that the forensic overlay (EvidenceOverlay) never had this problem,
 * because it replays geometry rather than tracking live video.
 */
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { onLive, type AnprExtra, type FaceExtra, type LiveTrack, type PeopleExtra } from "@/lib/live";
import { playWhep, whepUrl, type FeedState } from "@/lib/whep";
import type { Point, Severity, ZoneGeometry } from "@/lib/types";

const SEVERITY_COLOUR: Record<Severity, string> = {
  INFO: "#78716c",
  WARNING: "#f59e0b",
  CRITICAL: "#dc2626",
};

/** Recent-movement aid, not a record (see trailsRef comment below). */
const TRAIL_MAX_POINTS = 50;
const TRAIL_STALE_SECONDS = 3;

/**
 * A stable key for one tracked subject.
 *
 * Prefers multi_human's own `person_id` ("P1", "P2", ...) when a module
 * supplies one: it names one appearance-matched span of tracks, not one
 * ByteTrack id, so the SAME person keeps the same key -- and so the same
 * colour and the same trail -- across a short occlusion or a re-entry the
 * reid provider matched. Falls back to the run-scoped `track_ref` (a bare
 * integer id is reused once a track dies -- two different people would share
 * a trail and a colour), and to the track id only when a module omits both.
 */
const keyOf = (track: LiveTrack): string => {
  const extra = track.extra as { track_ref?: string; person_id?: string } | undefined;
  return extra?.person_id ?? extra?.track_ref ?? `id:${track.track_id ?? "?"}`;
};

/** Deterministic per-track colour so two overlapping trails stay readable
 * without a legend -- same track, same colour, every tile, every render. */
function colourFor(trackRef: string): string {
  let hash = 0;
  for (let i = 0; i < trackRef.length; i++) {
    hash = (hash * 31 + trackRef.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 85%, 60%)`;
}

/** Narrow on purpose, matching CameraMap's reasoning about payload drift. */
export interface FeedZone {
  id: string;
  name: string;
  geometry: ZoneGeometry;
  points: Point[];
  severity: Severity;
}

export interface CameraFeedProps {
  cameraId: string;
  streamPath?: string;
  whepBase?: string;
  zones?: FeedZone[];
  /** Which module's view to draw. `null` merges all of them. */
  module?: string | null;
  /** Off for a wall of tiles where the boxes would be too small to read. */
  showBoxes?: boolean;
  className?: string;
}

export function CameraFeed({
  cameraId,
  streamPath,
  whepBase,
  zones = [],
  module = null,
  showBoxes = true,
  className,
}: CameraFeedProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Tracks live in a ref, not state: they arrive several times a second and
  // re-rendering React that often to move a rectangle would be pure waste.
  // The canvas is redrawn from an animation frame instead.
  const tracksRef = useRef<LiveTrack[]>([]);
  // Client-side only, by design: the live channel is stateless per-frame (see
  // module comment above) and the edge node never stores a live path either --
  // it only keeps one in RAM per track, flushed to a row when a zone crossing
  // actually fires. A short recent trail here is purely a viewing aid, gone
  // the moment this tile unmounts, never a record of anything.
  const trailsRef = useRef<Map<string, { pts: Array<[number, number]>; mono: number }>>(new Map());
  // Separate from trailsRef because it is sourced from a DIFFERENT module's
  // ticks (face, not multi_human/fence) at a coarser cadence (face_every) --
  // see the observations effect below for why blending it into tracksRef's
  // per-message overwrite would make the alert ring flicker at that cadence.
  const matchesRef = useRef<Map<string, { name: string; score: number; signal: string; mono: number }>>(new Map());
  const [feed, setFeed] = useState<FeedState>("connecting");
  const [detail, setDetail] = useState<string>();
  // React state (not a ref) ON PURPOSE, unlike tracksRef/trailsRef above:
  // this drives the outer tile's border, which is real DOM the browser must
  // actually re-render, not a canvas pixel the draw loop can just repaint
  // next frame. Kept to a sorted name list, set only when it actually
  // changes, so a steady, ongoing match does not re-render every observation.
  const [watchlistNames, setWatchlistNames] = useState<string[]>([]);

  const path = streamPath ?? cameraId;

  // ── video ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!whepBase) {
      setFeed("down");
      setDetail("no media hub configured");
      return;
    }
    const handle = playWhep(video, whepUrl(whepBase, path), (state, why) => {
      setFeed(state);
      setDetail(why);
    });
    return () => handle.close();
  }, [whepBase, path]);

  // ── observations ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!showBoxes) {
      tracksRef.current = [];
      trailsRef.current.clear();
      matchesRef.current.clear();
      setWatchlistNames([]);
      return;
    }
    return onLive(cameraId, module, (observation) => {
      tracksRef.current = observation.tracks;

      // matchesRef is keyed independently of which module's tick most
      // recently overwrote tracksRef above: a match found on a face-module
      // tick must survive the many ordinary multi_human ticks in between
      // (face_every runs face at a coarser cadence), so a "no match" is only
      // trusted from the module that could actually have said so.
      for (const track of observation.tracks) {
        const watch = (track.extra as FaceExtra | undefined)?.watchlist_match;
        const key = keyOf(track);
        if (watch) {
          matchesRef.current.set(key, { ...watch, mono: observation.frame_ts });
        } else if (observation.module === "face") {
          matchesRef.current.delete(key);
        }
      }
      for (const [key, match] of matchesRef.current) {
        if (observation.frame_ts - match.mono > TRAIL_STALE_SECONDS) matchesRef.current.delete(key);
      }
      const names = [...new Set([...matchesRef.current.values()].map((m) => m.name))].sort();
      setWatchlistNames((prev) => {
        if (prev.length === names.length && prev.every((name, index) => name === names[index])) return prev;
        return names;
      });

      const seen = new Set<string>();
      for (const track of observation.tracks) {
        const key = keyOf(track);
        seen.add(key);
        const [x1, , x2, y2] = track.bbox;
        // Bottom centre -- the ground point, matching how the fence judges a
        // crossing (a box's centre would place a tall person's "position"
        // half a body above their feet).
        const point: [number, number] = [(x1 + x2) / 2, y2];

        const trail = trailsRef.current.get(key);
        if (trail) {
          trail.pts.push(point);
          if (trail.pts.length > TRAIL_MAX_POINTS) trail.pts.shift();
          trail.mono = observation.frame_ts;
        } else {
          trailsRef.current.set(key, { pts: [point], mono: observation.frame_ts });
        }
      }
      // Drop trails for tracks that vanished a while ago, so a person who left
      // frame doesn't leave a permanent ghost line behind. Anything still in
      // `seen` this tick was just refreshed above.
      for (const [ref, trail] of trailsRef.current) {
        if (!seen.has(ref) && observation.frame_ts - trail.mono > TRAIL_STALE_SECONDS) {
          trailsRef.current.delete(ref);
        }
      }
    });
  }, [cameraId, module, showBoxes]);

  // ── drawing ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const context = canvas.getContext("2d");
      if (!context) return;

      // Match the backing store to the CSS box, so lines are crisp on a
      // high-DPI screen instead of being scaled up after the fact.
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      // Zones first, so a box sits on top of the shape it may be crossing.
      for (const zone of zones) {
        if (zone.points.length < 2) continue;
        context.strokeStyle = SEVERITY_COLOUR[zone.severity] ?? SEVERITY_COLOUR.INFO;
        context.lineWidth = 2;
        context.setLineDash(zone.geometry === "line" ? [] : [6, 4]);
        context.beginPath();
        zone.points.forEach(([x, y], index) => {
          const px = x * width;
          const py = y * height;
          if (index === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        });
        if (zone.geometry === "polygon") {
          context.closePath();
          context.fillStyle = `${SEVERITY_COLOUR[zone.severity] ?? "#78716c"}1a`;
          context.fill();
        }
        context.stroke();
      }
      context.setLineDash([]);

      // Trails under boxes: the current position is what matters most and
      // should never be occluded by where a track has already been.
      //
      // A module's OWN trail (multi_human's `person_id`-keyed span, or
      // fence's) wins over the client-accumulated one below: it is the
      // continuous line across the whole appearance-matched identity,
      // including straight across an occlusion gap, while the client-side
      // trail is pruned after TRAIL_STALE_SECONDS and would show a fresh,
      // disconnected line for the same person after any real gap.
      const drawnByModule = new Set<string>();
      for (const track of tracksRef.current) {
        const moduleTrail = (track.extra as PeopleExtra | undefined)?.trail;
        if (!moduleTrail || moduleTrail.length < 2) continue;
        const key = keyOf(track);
        drawnByModule.add(key);
        context.strokeStyle = colourFor(key);
        context.lineWidth = 2;
        context.lineJoin = "round";
        context.beginPath();
        moduleTrail.forEach(([x, y], index) => {
          const px = x * width;
          const py = y * height;
          if (index === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        });
        context.stroke();
      }
      for (const [key, trail] of trailsRef.current) {
        if (drawnByModule.has(key) || trail.pts.length < 2) continue;
        context.strokeStyle = colourFor(key);
        context.lineWidth = 2;
        context.lineJoin = "round";
        context.beginPath();
        trail.pts.forEach(([x, y], index) => {
          const px = x * width;
          const py = y * height;
          if (index === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        });
        context.stroke();
      }

      // Boxes are neutral by design. The vision service reports that a subject
      // crossed; it does not decide what that is worth -- severity follows the
      // zone's operator-editable targets, one layer up. So a box says "a person
      // is here", never "this is an alarm". The alarm arrives separately, as an
      // incident, from the node.
      for (const track of tracksRef.current) {
        const [x1, y1, x2, y2] = track.bbox;
        const px = x1 * width;
        const py = y1 * height;
        const pw = (x2 - x1) * width;
        const ph = (y2 - y1) * height;

        // Read from matchesRef, not track.extra directly: this tick may be a
        // plain multi_human observation with no watchlist_match field at
        // all, while the match itself is still current (see the
        // observations effect above for why the two are decoupled).
        const match = matchesRef.current.get(keyOf(track));

        // The one box on this tile that IS an alarm, not a neutral report:
        // a watchlist hit is an operator-enrolled identity claim, not an
        // automated severity judgement, so it earns its own colour rather
        // than reusing a zone's amber -- see displayFor() in people.tsx for
        // the same priority rule applied to the People page's own view.
        context.strokeStyle = match ? "#f59e0b" : "#38bdf8";
        context.lineWidth = match ? 3 : 2;
        context.strokeRect(px, py, pw, ph);

        const personId = (track.extra as PeopleExtra | undefined)?.person_id;
        const label = match
          ? `${match.name} ${(match.score * 100).toFixed(0)}%${match.signal === "appearance" ? " (clothing)" : ""}`
          : `${personId ?? track.class} ${(track.confidence * 100).toFixed(0)}%`;
        context.font = "11px ui-monospace, monospace";
        const textWidth = context.measureText(label).width;
        context.fillStyle = match ? "#f59e0b" : "#38bdf8";
        context.fillRect(px, Math.max(0, py - 15), textWidth + 8, 15);
        context.fillStyle = match ? "#451a03" : "#0c223a";
        context.fillText(label, px + 4, Math.max(11, py - 4));

        // A live plate guess, when the ANPR module supplied one. Drawn in a
        // different colour and never styled like a confirmation: this is an
        // unconfirmed read off the live channel, and the accepted one arrives
        // from the node as a plate_detection record.
        const plate = (track.extra as AnprExtra | undefined)?.plate;
        if (plate) {
          const [bx1, by1, bx2, by2] = plate.bbox;
          context.strokeStyle = "#fbbf24";
          context.lineWidth = 2;
          context.strokeRect(
            bx1 * width, by1 * height,
            (bx2 - bx1) * width, (by2 - by1) * height,
          );
          context.font = "12px ui-monospace, monospace";
          const plateWidth = context.measureText(plate.text).width;
          context.fillStyle = "#fbbf24";
          context.fillRect(bx1 * width, Math.max(0, by1 * height - 16), plateWidth + 8, 16);
          context.fillStyle = "#1c1917";
          context.fillText(plate.text, bx1 * width + 4, Math.max(12, by1 * height - 4));
        }

        // A face, when the face module found one inside this person's box.
        // Detection only -- drawn the same neutral way a person box is, never
        // styled as a match or a name, because it is neither.
        const face = (track.extra as FaceExtra | undefined)?.face;
        if (face) {
          const [gx1, gy1, gx2, gy2] = face.bbox;
          context.strokeStyle = "#a3e635";
          context.lineWidth = 2;
          context.strokeRect(
            gx1 * width, gy1 * height,
            (gx2 - gx1) * width, (gy2 - gy1) * height,
          );
          const label = `face ${(face.score * 100).toFixed(0)}%`;
          context.font = "11px ui-monospace, monospace";
          const faceLabelWidth = context.measureText(label).width;
          context.fillStyle = "#a3e635";
          context.fillRect(gx1 * width, Math.max(0, gy1 * height - 15), faceLabelWidth + 8, 15);
          context.fillStyle = "#052e16";
          context.fillText(label, gx1 * width + 4, Math.max(11, gy1 * height - 4));
        }
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [zones]);

  return (
    <div
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-md border bg-black",
        // The "notify" part of a watchlist match: this tile's OWN border, not
        // just the box inside it, so a match is visible even glanced at from
        // across a wall of tiles where a single amber rectangle would be too
        // small to register. ring, not border-color, so it draws outside the
        // tile's existing border rather than fighting it for the same pixels.
        watchlistNames.length > 0 && "ring-4 ring-red-500 animate-pulse",
        className,
      )}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="h-full w-full object-contain"
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {watchlistNames.length > 0 && (
        <div className="absolute left-2 top-2 z-10 flex flex-wrap gap-1">
          {watchlistNames.map((name) => (
            <Badge key={name} variant="destructive" className="gap-1 text-[10px]">
              {name}
            </Badge>
          ))}
        </div>
      )}

      {feed !== "live" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center">
          <Badge variant={feed === "down" ? "destructive" : "secondary"}>
            {feed === "connecting" ? "connecting" : "no video"}
          </Badge>
          {/* The reason, not just the state. "Failed" sends somebody to read
              logs; "no such stream on the hub" sends them to the right file. */}
          {detail && (
            <p className="max-w-[28ch] text-xs text-white/70">{detail}</p>
          )}
        </div>
      )}
    </div>
  );
}
