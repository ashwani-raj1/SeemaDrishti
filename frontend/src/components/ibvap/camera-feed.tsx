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
import { onLive, type AnprExtra, type LiveTrack } from "@/lib/live";
import { playWhep, whepUrl, type FeedState } from "@/lib/whep";
import type { Point, Severity, ZoneGeometry } from "@/lib/types";

const SEVERITY_COLOUR: Record<Severity, string> = {
  INFO: "#78716c",
  WARNING: "#f59e0b",
  CRITICAL: "#dc2626",
};

/** Deliberately NOT a severity colour: a provisional shape has no severity,
 *  because the node never alerts on one. Matches ProvisionalBadge. */
const PROVISIONAL_COLOUR = "#a16207";

/** Recent-movement aid, not a record (see trailsRef comment below). */
const TRAIL_MAX_POINTS = 50;
const TRAIL_STALE_SECONDS = 3;

/**
 * A stable key for one tracked subject.
 *
 * Prefers the run-scoped `track_ref` the vision service already computes,
 * because a bare integer id is reused once a track dies -- two different people
 * would share a trail and a colour. Falls back only when a module omits it.
 */
const keyOf = (track: LiveTrack): string => {
  const ref = (track.extra as { track_ref?: string } | undefined)?.track_ref;
  return ref ?? `id:${track.track_id ?? "?"}`;
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
  /** Stock placeholder nobody drew; drawn differently, never alerted on. */
  provisional?: boolean;
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
  const [feed, setFeed] = useState<FeedState>("connecting");
  const [detail, setDetail] = useState<string>();

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
      return;
    }
    return onLive(cameraId, module, (observation) => {
      tracksRef.current = observation.tracks;

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

      // WHERE THE PICTURE ACTUALLY IS.
      //
      // The container is a hard 16:9 box and the <video> inside it is
      // object-contain, so any source that is not 16:9 is letterboxed -- but
      // this canvas is inset-0 and spans the whole container. Mapping 0..1
      // across the container therefore puts every zone, box and trail off by
      // the width of the bar, and worst at the edges, which is exactly where a
      // fence line is drawn.
      //
      // shape-editor.tsx solves the same problem the other way, by forcing the
      // container to the frame's aspect -- it has to, because a CLICK must land
      // in frame space. This tile only draws, so it maps into the fitted rect
      // and leaves the grid layout above it alone. Before metadata arrives the
      // fallback is full-bleed, which is the old behaviour.
      const video = videoRef.current;
      const vw = video?.videoWidth ?? 0;
      const vh = video?.videoHeight ?? 0;
      const fit = vw && vh ? Math.min(width / vw, height / vh) : 0;
      const dw = fit ? vw * fit : width;
      const dh = fit ? vh * fit : height;
      const ox = (width - dw) / 2;
      const oy = (height - dh) / 2;
      /** Normalised frame coordinate -> canvas pixel. */
      const sx = (x: number) => ox + x * dw;
      const sy = (y: number) => oy + y * dh;

      // Zones first, so a box sits on top of the shape it may be crossing.
      for (const zone of zones) {
        if (zone.points.length < 2) continue;
        // A shape nobody drew must not be mistakable for one an operator
        // placed. Muted amber, and dashed REGARDLESS of geometry -- dashing
        // only polygons would leave a provisional LINE looking exactly like a
        // real fence, which is the common case.
        const colour = zone.provisional
          ? PROVISIONAL_COLOUR
          : SEVERITY_COLOUR[zone.severity] ?? SEVERITY_COLOUR.INFO;
        context.strokeStyle = colour;
        context.lineWidth = 2;
        context.setLineDash(zone.provisional || zone.geometry !== "line" ? [6, 4] : []);
        context.beginPath();
        zone.points.forEach(([x, y], index) => {
          const px = sx(x);
          const py = sy(y);
          if (index === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        });
        if (zone.geometry === "polygon") {
          context.closePath();
          context.fillStyle = `${colour}${zone.provisional ? "0d" : "1a"}`;
          context.fill();
        }
        context.stroke();

        if (zone.provisional) {
          const [fx, fy] = zone.points[0]!;
          context.setLineDash([]);
          context.font = "10px ui-monospace, monospace";
          context.fillStyle = PROVISIONAL_COLOUR;
          context.fillText("provisional", sx(fx) + 4, Math.max(10, sy(fy) - 5));
        }
      }
      context.setLineDash([]);

      // Trails under boxes: the current position is what matters most and
      // should never be occluded by where a track has already been.
      for (const [trackRef, trail] of trailsRef.current) {
        if (trail.pts.length < 2) continue;
        context.strokeStyle = colourFor(trackRef);
        context.lineWidth = 2;
        context.lineJoin = "round";
        context.beginPath();
        trail.pts.forEach(([x, y], index) => {
          const px = sx(x);
          const py = sy(y);
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
        const px = sx(x1);
        const py = sy(y1);
        const pw = (x2 - x1) * dw;
        const ph = (y2 - y1) * dh;

        context.strokeStyle = "#38bdf8";
        context.lineWidth = 2;
        context.strokeRect(px, py, pw, ph);

        const label = `${track.class} ${(track.confidence * 100).toFixed(0)}%`;
        context.font = "11px ui-monospace, monospace";
        const textWidth = context.measureText(label).width;
        context.fillStyle = "#38bdf8";
        context.fillRect(px, Math.max(0, py - 15), textWidth + 8, 15);
        context.fillStyle = "#0c223a";
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
            sx(bx1), sy(by1),
            (bx2 - bx1) * dw, (by2 - by1) * dh,
          );
          context.font = "12px ui-monospace, monospace";
          const plateWidth = context.measureText(plate.text).width;
          context.fillStyle = "#fbbf24";
          context.fillRect(sx(bx1), Math.max(0, sy(by1) - 16), plateWidth + 8, 16);
          context.fillStyle = "#1c1917";
          context.fillText(plate.text, sx(bx1) + 4, Math.max(12, sy(by1) - 4));
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
