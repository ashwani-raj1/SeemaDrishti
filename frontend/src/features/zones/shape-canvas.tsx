import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcwIcon, TrashIcon, UndoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useClient } from "@/client/context";
import { playWhep, whepUrl, type FeedState } from "@/lib/whep";
import { onVisionStatus, visionStatus } from "@/lib/live";
import type { Direction, Point, ZoneGeometry } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Drawing a zone on the camera's own picture.
 *
 * WHY IMAGE SPACE AND NOT A MAP. A zone's points are normalised 0..1 against
 * the camera frame, and that is the coordinate system the detector actually
 * judges in: `modules/fence.py` compares a detection's bottom-centre against
 * exactly these numbers. So what a supervisor draws here IS what fires -- there
 * is no projection step in between to be wrong about. Drawing on satellite
 * imagery would need a per-camera homography nobody has surveyed, and every
 * shape would be a guess dressed up as a map.
 *
 * The map still matters, for "which camera, where" -- it just cannot be the
 * editor.
 *
 * ASPECT RATIO IS LOAD-BEARING, not styling. The video is letterboxed inside
 * whatever box CSS gives it, so a click's fraction-of-the-container is NOT the
 * fraction-of-the-frame unless the two have the same shape. Get that wrong and
 * every zone is drawn a few percent off from where the detector reads it --
 * silently, and only at the edges, which is exactly where a fence line lives.
 * So the frame's real dimensions are measured and the container is forced to
 * match before a single point can be placed.
 *
 * LINE DIRECTION IS A CONVENTION AND IT IS STATED ON SCREEN. Inbound means the
 * subject moved onto the right-hand side of the line looking along first point
 * -> last point. A supervisor who draws the line the other way gets inbound and
 * outbound swapped, which is the kind of thing that is obvious in a comment and
 * invisible at 3 a.m., so the editor draws an arrow rather than explaining it.
 *
 * WHY THIS IS A CONTROLLED COMPONENT AND SAVES NOTHING. Two callers need the
 * identical drawing surface against two different kinds of truth: the zones
 * screen edits a shape that already exists on the node, and the new-zone wizard
 * draws shapes for a zone that does not exist yet and may never. Owning the
 * state here would have forced the wizard to create the zone first just to have
 * something to PATCH -- which is how a cancelled wizard leaves a live zone
 * behind. So the surface draws, and the caller decides what a shape means.
 */

/** This camera's processed frame rate, if a worker is reporting one. */
function fpsFor(cameraId: string): number | null {
  const camera = visionStatus()?.cameras?.find((c) => c.camera_id === cameraId);
  return camera && camera.fps > 0 ? camera.fps : null;
}

export const MIN_POINTS: Record<ZoneGeometry, number> = { line: 2, polygon: 3 };

/** A shape as drawn, before anybody decides whether to keep it. */
export interface ShapeDraft {
  geometry: ZoneGeometry;
  points: Point[];
  direction: Direction | "both";
  confirmSeconds: number;
}

/** Why this shape cannot be used yet, or null when it can. */
export function shapeProblem(draft: ShapeDraft): string | null {
  const need = MIN_POINTS[draft.geometry];
  if (draft.points.length < need) {
    return `A ${draft.geometry} needs at least ${need} points — you have ${draft.points.length}.`;
  }
  return null;
}

export interface ShapeCanvasProps {
  cameraId: string;
  value: ShapeDraft;
  onChange: (next: ShapeDraft) => void;
  /** What Revert goes back to. The stored shape, or the placeholder. */
  revertTo: Point[];
  /** False while the parent dialog is closed, so the feed is not held open. */
  active?: boolean;
  className?: string;
}

export function ShapeCanvas({
  cameraId, value, onChange, revertTo, active = true, className,
}: ShapeCanvasProps) {
  const { media } = useClient();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  const [feed, setFeed] = useState<FeedState>("connecting");
  const [detail, setDetail] = useState<string>();
  const [aspect, setAspect] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  /**
   * The rate this camera is ACTUALLY processed at, from the vision service's
   * own status message -- not the configured target.
   *
   * `confirm_seconds` is only half the confirmation rule: `modules/fence.py`
   * also demands `confirm_frames`, and both must be satisfied. A supervisor
   * setting "2 seconds" on a 5.7 fps worker is asking a subject to stay
   * tracked for about twelve processed frames after crossing, which is longer
   * than a vehicle's track usually survives. Stating the frame count is the
   * difference between a number that looks careful and a number that silently
   * means nothing ever confirms.
   */
  const [fps, setFps] = useState<number | null>(() => fpsFor(cameraId));
  useEffect(() => {
    setFps(fpsFor(cameraId));
    return onVisionStatus(() => setFps(fpsFor(cameraId)));
  }, [cameraId]);

  const { geometry, points, direction, confirmSeconds } = value;
  const patch = useCallback(
    (fields: Partial<ShapeDraft>) => onChange({ ...value, ...fields }),
    [onChange, value],
  );

  // ── the picture ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    if (!video) return;
    if (!media?.whepBase) {
      setFeed("down");
      setDetail("no media hub configured");
      return;
    }
    const handle = playWhep(video, whepUrl(media.whepBase, cameraId), (state, why) => {
      setFeed(state);
      setDetail(why);
    });
    return () => handle.close();
  }, [active, media?.whepBase, cameraId]);

  /** The frame's real shape. Until this is known, points cannot be placed. */
  const measure = useCallback(() => {
    const video = videoRef.current;
    if (video?.videoWidth && video.videoHeight) {
      setAspect(video.videoWidth / video.videoHeight);
    }
  }, []);

  const toNormalised = useCallback((event: { clientX: number; clientY: number }): Point | null => {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    // Clamped, not rejected: a drag that leaves the frame should pin the point
    // to the edge rather than drop it, because a fence line commonly runs
    // right to the border of the picture.
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    return [Number(x.toFixed(4)), Number(y.toFixed(4))];
  }, []);

  const addPoint = (event: React.MouseEvent) => {
    if (dragging !== null) return;
    // The frame's shape is not known until onLoadedMetadata fires, and until
    // then the container is holding a GUESSED 16/9. A click now would be
    // normalised against a box that is not the picture, and land somewhere
    // else the moment the real aspect arrives -- silently, since a point is a
    // point wherever it is. The container already shows cursor-wait in this
    // state; this makes the handler agree with it.
    if (aspect === null) return;
    const point = toNormalised(event);
    if (point) patch({ points: [...points, point] });
  };

  // The drag listeners are attached once per drag, so they must not close over
  // `value` -- it changes on every mousemove and a stale copy would snap the
  // other points back to where they were when the drag started.
  const onChangeRef = useRef<(update: (current: ShapeDraft) => ShapeDraft) => void>(() => {});
  onChangeRef.current = (update) => onChange(update(value));

  // Dragging is on the window, not the handle: a fast drag outruns the pointer
  // and would otherwise drop the point the moment the cursor left the circle.
  useEffect(() => {
    if (dragging === null) return;
    const move = (event: MouseEvent) => {
      const box = frameRef.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return;
      const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
      const moved: Point = [Number(x.toFixed(4)), Number(y.toFixed(4))];
      onChangeRef.current((current) => ({
        ...current,
        points: current.points.map((existing, index) => (index === dragging ? moved : existing)),
      }));
    };
    const up = () => setDragging(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragging]);

  // A line with a bend in it: drawn as a polyline, judged for direction as a
  // straight line through its ends. Worth saying out loud -- see EffectiveLine.
  const kinked = geometry === "line" && points.length > 2;

  const svgPoints = points.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div
        ref={frameRef}
        onClick={addPoint}
        onMouseDown={(event) => event.preventDefault()}
        className={cn(
          "relative w-full overflow-hidden rounded-md border bg-black",
          aspect ? "cursor-crosshair" : "cursor-wait",
        )}
        style={{ aspectRatio: aspect ?? 16 / 9 }}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          onLoadedMetadata={measure}
          onResize={measure}
          className="h-full w-full"
        />

        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          {geometry === "polygon" && points.length >= 3 && (
            <polygon
              points={svgPoints}
              fill="rgba(16,185,129,0.18)"
              stroke="#10b981"
              strokeWidth="0.4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {geometry === "line" && points.length >= 2 && (
            <polyline
              points={svgPoints}
              fill="none"
              stroke="#10b981"
              strokeWidth="0.4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {points.map(([x, y], index) => (
            <circle
              key={index}
              cx={x * 100}
              cy={y * 100}
              r="1.1"
              fill={index === 0 ? "#f59e0b" : "#10b981"}
              stroke="#000"
              strokeWidth="0.2"
              vectorEffect="non-scaling-stroke"
              className="pointer-events-auto cursor-grab"
              onMouseDown={(event) => {
                event.stopPropagation();
                event.preventDefault();
                setDragging(index);
              }}
            />
          ))}
        </svg>

        {/* The inbound side, drawn rather than described. A line drawn
            left-to-right has its inbound side below it; drawing it the
            other way swaps inbound and outbound, and no amount of help
            text makes that as obvious as an arrow does. */}
        {geometry === "line" && points.length >= 2 && (
          <InboundArrow from={points[0]!} to={points[points.length - 1]!} />
        )}

        {/* The line the detector actually measures SIDES against, when it is
            not the line on screen. `core/geometry.py:side_for_zone` takes the
            infinite line through the first and last vertex and ignores every
            vertex between them, while `crossing_of` still requires the move to
            intersect a DRAWN segment. Two geometries, one shape -- and with
            only the drawn one visible, a supervisor watching cars flip sides
            in the overlay has no way to see why nothing ever fires. */}
        {geometry === "line" && points.length > 2 && (
          <EffectiveLine from={points[0]!} to={points[points.length - 1]!} />
        )}

        {feed !== "live" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-center">
            <Badge variant={feed === "down" ? "destructive" : "secondary"}>
              {feed === "connecting" ? "connecting" : "no video"}
            </Badge>
            {detail && <p className="max-w-[36ch] text-xs text-white/70">{detail}</p>}
            <p className="max-w-[40ch] text-xs text-white/50">
              A shape can still be drawn without a picture, but placing it blind
              is guesswork.
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Shape</Label>
          <Select
            value={geometry}
            onValueChange={(next) => patch({ geometry: next as ZoneGeometry })}
          >
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="line">Line / fence</SelectItem>
              <SelectItem value="polygon">Area</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Direction</Label>
          <Select
            value={direction}
            onValueChange={(next) => patch({ direction: next as Direction | "both" })}
          >
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="both">Both ways</SelectItem>
              <SelectItem value="inbound">Inbound only</SelectItem>
              <SelectItem value="outbound">Outbound only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Confirm for</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              step={0.5}
              value={confirmSeconds}
              onChange={(event) => patch({ confirmSeconds: Number(event.target.value) })}
              className="w-[90px]"
            />
            <span className="text-sm text-muted-foreground">seconds</span>
          </div>
          {fps !== null && (
            <span
              className={cn(
                "text-[11px]",
                confirmSeconds * fps > 8 ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
              )}
            >
              {confirmSeconds === 0
                ? `fires on the first frame · ${fps.toFixed(1)} fps`
                : `≈ ${Math.ceil(confirmSeconds * fps)} frames at ${fps.toFixed(1)} fps${
                    confirmSeconds * fps > 8 ? " — longer than most vehicle tracks survive" : ""
                  }`}
            </span>
          )}
        </div>

        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={points.length === 0}
            onClick={() => patch({ points: points.slice(0, -1) })}
          >
            <UndoIcon /> Undo
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={points.length === 0}
            onClick={() => patch({ points: [] })}
          >
            <TrashIcon /> Clear
          </Button>
          <Button variant="ghost" size="sm" onClick={() => patch({ points: revertTo })}>
            <RotateCcwIcon /> Revert
          </Button>
        </div>
      </div>

      <Alert variant={kinked ? "destructive" : "default"}>
        <AlertTitle className="text-xs">
          {points.length} point{points.length === 1 ? "" : "s"}
          {geometry === "line" && " · first point is amber"}
          {kinked && " · only the first and last set the direction"}
        </AlertTitle>
        <AlertDescription className="text-xs">
          {geometry === "polygon"
            ? "Inbound means entering the area, outbound means leaving it."
            : kinked
              ? "A crossing only counts where a subject moves across a segment you drew. The dashed line is what decides inbound versus outbound — every point between the first and last is ignored for that. If you meant “inside this region”, switch to Area."
              : "Inbound is the right-hand side looking from the first point to the last — the arrow shows it. Draw along the fence with the friendly side on the arrow's side."}
        </AlertDescription>
      </Alert>

      {/* The single most expensive thing to discover at 3 a.m.: a shape that
          can never fire because nothing travels across it. Said here, where
          the shape is being drawn, rather than left for somebody to work out
          from an empty incident list days later. */}
      {geometry === "line" && points.length >= 2 && (
        <p className="text-xs text-muted-foreground">
          Put this across the path subjects actually travel. A line beside the
          route rather than over it records nothing, and reads exactly like a
          detector that is switched off.
        </p>
      )}
    </div>
  );
}

/**
 * The infinite line the detector reduces a kinked polyline to.
 *
 * Extended well past the frame on both sides because that is genuinely what
 * `side_for_zone` uses -- an unbounded line, not the segment between the two
 * vertices. Drawing only the segment would understate it and leave the same
 * confusion in a smaller form.
 */
function EffectiveLine({ from, to }: { from: Point; to: Point }) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const reach = 3; // multiples of the frame, so the ends are always off-screen
  const ax = (x1 - (dx / length) * reach) * 100;
  const ay = (y1 - (dy / length) * reach) * 100;
  const bx = (x2 + (dx / length) * reach) * 100;
  const by = (y2 + (dy / length) * reach) * 100;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <line
        x1={ax}
        y1={ay}
        x2={bx}
        y2={by}
        stroke="#38bdf8"
        strokeWidth="0.35"
        strokeDasharray="2 2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** An arrow at the line's midpoint, pointing at its inbound side. */
function InboundArrow({ from, to }: { from: Point; to: Point }) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const midX = ((x1 + x2) / 2) * 100;
  const midY = ((y1 + y2) / 2) * 100;
  // Right-hand normal of (p1 -> p2), matching sideOf() in core/geometry.py:
  // positive side is the right-hand side looking along the segment.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const nx = (-dy / length) * 10;
  const ny = (dx / length) * 10;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <defs>
        <marker id="inbound-head" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#f59e0b" />
        </marker>
      </defs>
      <line
        x1={midX}
        y1={midY}
        x2={midX + nx}
        y2={midY + ny}
        stroke="#f59e0b"
        strokeWidth="0.5"
        vectorEffect="non-scaling-stroke"
        markerEnd="url(#inbound-head)"
      />
      <text
        x={midX + nx * 1.2}
        y={midY + ny * 1.2}
        fill="#f59e0b"
        fontSize="3"
        textAnchor="middle"
      >
        inbound
      </text>
    </svg>
  );
}
