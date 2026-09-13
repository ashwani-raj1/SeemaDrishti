import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { RotateCcwIcon, TrashIcon, UndoIcon } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ibvap/spinner";
import { useClient } from "@/client/context";
import { playWhep, whepUrl, type FeedState } from "@/lib/whep";
import { api } from "@/lib/api";
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
 */

const MIN_POINTS: Record<ZoneGeometry, number> = { line: 2, polygon: 3 };

export interface ShapeEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zoneId: string;
  zoneName: string;
  cameraId: string;
  cameraName: string;
  geometry: ZoneGeometry;
  points: Point[];
  direction: Direction | "both";
  confirmSeconds: number;
  onSaved: () => void;
}

export function ShapeEditor({
  open, onOpenChange, zoneId, zoneName, cameraId, cameraName,
  geometry: initialGeometry, points: initialPoints,
  direction: initialDirection, confirmSeconds: initialConfirm, onSaved,
}: ShapeEditorProps) {
  const { media } = useClient();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  const [geometry, setGeometry] = useState<ZoneGeometry>(initialGeometry);
  const [points, setPoints] = useState<Point[]>(initialPoints);
  const [direction, setDirection] = useState<Direction | "both">(initialDirection);
  const [confirmSeconds, setConfirmSeconds] = useState(initialConfirm);
  const [reason, setReason] = useState("");
  const [feed, setFeed] = useState<FeedState>("connecting");
  const [detail, setDetail] = useState<string>();
  const [aspect, setAspect] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset to the stored shape every time the dialog opens, so an abandoned
  // edit never leaks into the next one.
  useEffect(() => {
    if (!open) return;
    setGeometry(initialGeometry);
    setPoints(initialPoints);
    setDirection(initialDirection);
    setConfirmSeconds(initialConfirm);
    setReason("");
  }, [open, initialGeometry, initialPoints, initialDirection, initialConfirm]);

  // ── the picture ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
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
  }, [open, media?.whepBase, cameraId]);

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

  const addPoint = useCallback(
    (event: React.MouseEvent) => {
      if (dragging !== null) return;
      const point = toNormalised(event);
      if (point) setPoints((current) => [...current, point]);
    },
    [dragging, toNormalised],
  );

  // Dragging is on the window, not the handle: a fast drag outruns the pointer
  // and would otherwise drop the point the moment the cursor left the circle.
  useEffect(() => {
    if (dragging === null) return;
    const move = (event: MouseEvent) => {
      const point = toNormalised(event);
      if (!point) return;
      setPoints((current) => current.map((existing, index) => (index === dragging ? point : existing)));
    };
    const up = () => setDragging(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragging, toNormalised]);

  const enough = points.length >= MIN_POINTS[geometry];
  const problem = !enough
    ? `A ${geometry} needs at least ${MIN_POINTS[geometry]} points — you have ${points.length}.`
    : reason.trim().length < 3
      ? "Say why this shape is changing. It is recorded against your name."
      : null;

  const save = async () => {
    setSaving(true);
    try {
      await api.updateZoneCamera(zoneId, cameraId, {
        geometry,
        points,
        direction,
        confirmSeconds,
        reason,
      });
      toast.success("Zone shape saved", {
        description: `${zoneName} on ${cameraName} — the detector picks it up within its refresh interval.`,
      });
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const svgPoints = points.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {zoneName} · {cameraName}
          </DialogTitle>
          <DialogDescription>
            Click the picture to place points. Drag a point to move it. These are
            the exact coordinates the detector judges against.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
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

            {feed !== "live" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-center">
                <Badge variant={feed === "down" ? "destructive" : "secondary"}>
                  {feed === "connecting" ? "connecting" : "no video"}
                </Badge>
                {detail && <p className="max-w-[36ch] text-xs text-white/70">{detail}</p>}
                <p className="max-w-[40ch] text-xs text-white/50">
                  A shape can still be drawn and saved without a picture, but
                  placing it blind is guesswork.
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Shape</Label>
              <Select
                value={geometry}
                onValueChange={(value) => setGeometry(value as ZoneGeometry)}
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
                onValueChange={(value) => setDirection(value as Direction | "both")}
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
                  onChange={(event) => setConfirmSeconds(Number(event.target.value))}
                  className="w-[90px]"
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="ml-auto flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={points.length === 0}
                onClick={() => setPoints((current) => current.slice(0, -1))}
              >
                <UndoIcon /> Undo
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={points.length === 0}
                onClick={() => setPoints([])}
              >
                <TrashIcon /> Clear
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPoints(initialPoints)}
              >
                <RotateCcwIcon /> Revert
              </Button>
            </div>
          </div>

          <Alert>
            <AlertTitle className="text-xs">
              {points.length} point{points.length === 1 ? "" : "s"}
              {geometry === "line" && " · first point is amber"}
            </AlertTitle>
            <AlertDescription className="text-xs">
              {geometry === "line"
                ? "Inbound is the right-hand side looking from the first point to the last — the arrow shows it. Draw along the fence with the friendly side on the arrow's side."
                : "Inbound means entering the area, outbound means leaving it."}
            </AlertDescription>
          </Alert>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shape-reason">Reason for the change</Label>
            <Textarea
              id="shape-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. re-surveyed after the fence rebuild"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">{problem}</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={save} disabled={Boolean(problem) || saving}>
              {saving && <Spinner />} Save shape
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
