/**
 * One camera's live picture, with the fence drawn on it.
 *
 * Three independent sources compose this tile, and keeping them independent is
 * the whole design:
 *
 *   video   WHEP, hub -> browser        lib/whep.ts
 *   boxes   WS, vision -> browser       lib/boxes.ts     ephemeral
 *   zones   /api/config                 static until edited
 *
 * None of them can take the others down. The detector restarting freezes the
 * boxes and leaves the picture live; the edge node restarting touches neither.
 * The tile says which parts are working rather than showing a plausible-looking
 * still and letting somebody assume the rest is fine -- a screen that has
 * quietly stopped updating is the failure this whole console exists to prevent.
 *
 * OVERLAY ALIGNMENT IS BEST-EFFORT. WebRTC frame timestamps and detection
 * timestamps come from different clocks; the latest boxes are drawn over the
 * current frame without reconciling them. On a walking person the error is not
 * visible. Frame-accurate alignment needs a detection ring buffer keyed on
 * capture time and requestVideoFrameCallback, and is deliberately not built --
 * note that the forensic overlay (EvidenceOverlay) never had this problem,
 * because it replays geometry rather than tracking live video.
 */
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { onBoxes, type Box } from "@/lib/boxes";
import { playWhep, whepUrl, type FeedState } from "@/lib/whep";
import type { Point, Severity, ZoneGeometry } from "@/lib/types";

const SEVERITY_COLOUR: Record<Severity, string> = {
  INFO: "#78716c",
  WARNING: "#f59e0b",
  CRITICAL: "#dc2626",
};

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
  /** Off for a wall of tiles where the boxes would be too small to read. */
  showBoxes?: boolean;
  className?: string;
}

export function CameraFeed({
  cameraId,
  streamPath,
  whepBase,
  zones = [],
  showBoxes = true,
  className,
}: CameraFeedProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Boxes live in a ref, not state: they arrive several times a second and
  // re-rendering React that often to move a rectangle would be pure waste.
  // The canvas is redrawn from an animation frame instead.
  const boxesRef = useRef<Box[]>([]);
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

  // ── boxes ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!showBoxes) {
      boxesRef.current = [];
      return;
    }
    return onBoxes(cameraId, (frame) => {
      boxesRef.current = frame.boxes;
    });
  }, [cameraId, showBoxes]);

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

      // Boxes are neutral by design. The vision service does not know what a
      // zone is or what a severity means -- that lives one layer up -- so a
      // box says "a person is here", never "this is an alarm". The alarm
      // arrives separately, as an incident.
      for (const box of boxesRef.current) {
        const [x, y, w, h] = box.bbox;
        const px = x * width;
        const py = y * height;
        const pw = w * width;
        const ph = h * height;

        context.strokeStyle = "#38bdf8";
        context.lineWidth = 2;
        context.strokeRect(px, py, pw, ph);

        const label = `${box.class} ${(box.confidence * 100).toFixed(0)}%`;
        context.font = "11px ui-monospace, monospace";
        const textWidth = context.measureText(label).width;
        context.fillStyle = "#38bdf8";
        context.fillRect(px, Math.max(0, py - 15), textWidth + 8, 15);
        context.fillStyle = "#0c223a";
        context.fillText(label, px + 4, Math.max(11, py - 4));
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
