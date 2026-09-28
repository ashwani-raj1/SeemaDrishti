import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  onLive, onLiveState, type AnprExtra, type FaceExtra, type FenceExtra, type LiveState,
  type LiveTrack, type PeopleExtra,
} from "@/lib/live";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * What the detector is seeing on this camera, as it sees it.
 *
 * NOTHING HERE IS A RECORD. Every line is an unconfirmed observation off the
 * live channel: a box that exists this frame, a plate the OCR is currently
 * guessing, a crossing being held but not yet confirmed. The moment one of
 * these becomes a fact the system keeps, it arrives separately as an incident
 * from the node -- which is the panel next to this one. Operators must be able
 * to tell the two apart at a glance, so this one is deliberately styled as a
 * terminal feed and never carries a severity colour or an action button.
 *
 * THROTTLED ON PURPOSE. Observations arrive at the detector's cadence (6/s per
 * camera by default). Re-rendering a React list that often would burn the
 * operator's CPU to animate text nobody can read at that speed, so lines
 * accumulate in a ref and flush on an interval. The ref is the buffer; state
 * is only what is painted.
 */

const FLUSH_MS = 400;
const MAX_LINES = 60;

interface Line {
  key: string;
  at: number;
  klass: string;
  confidence: number;
  detail: string;
  /** True when the module is holding something back pending confirmation. */
  pending: boolean;
}

/** Turn one module's track into the one line worth reading about it. */
function describe(module: string, track: LiveTrack): { detail: string; pending: boolean } {
  if (module === "fence") {
    const extra = track.extra as FenceExtra;
    const held = extra.zones?.find((zone) => zone.pending);
    if (held) {
      return {
        detail: `${held.direction ?? "crossing"} ${held.name} · holding ${held.held.toFixed(1)}s`,
        pending: true,
      };
    }
    const inside = extra.zones?.filter((zone) => zone.side === 1).map((zone) => zone.name);
    return {
      detail: inside?.length ? `inside ${inside.join(", ")}` : "tracking",
      pending: false,
    };
  }

  if (module === "anpr") {
    const extra = track.extra as AnprExtra;
    if (extra.plate) {
      return {
        detail: `${extra.vehicle_type ?? "vehicle"} · plate ${extra.plate.text} ` +
          `(${(extra.plate.confidence * 100).toFixed(0)}%, unconfirmed)`,
        pending: true,
      };
    }
    return { detail: `${extra.vehicle_type ?? "vehicle"} · no readable plate`, pending: false };
  }

  if (module === "face") {
    const extra = track.extra as FaceExtra;
    // A watchlist match is the one thing on this feed that IS an identity
    // claim, not a bare detection -- surfaced here too, not just as a box
    // on the picture, because an operator reading this terminal feed while
    // glancing between camera tiles should not have to catch it visually.
    if (extra.watchlist_match) {
      const { name, score, signal } = extra.watchlist_match;
      return {
        detail: `matched: ${name} (${(score * 100).toFixed(0)}%, ${signal})`,
        pending: false,
      };
    }
    if (extra.face) {
      return { detail: `face ${(extra.face.score * 100).toFixed(0)}%`, pending: false };
    }
    return { detail: "no face in view", pending: false };
  }

  if (module === "multi_human") {
    const extra = track.extra as PeopleExtra;
    const age = extra.age_seconds ? `${extra.age_seconds.toFixed(0)}s in frame` : "new track";
    // `person_id` is a colour-appearance match (modules/reid.py's
    // HistogramReID), gated on motion plausibility -- real evidence, never a
    // name or a face. Unset while a new track is still in its confirmation
    // window (multi_human.py's PENDING_FRAMES), which is what `pending` says.
    return {
      detail: extra.person_id ? `${age} · ${extra.person_id}` : age,
      pending: !extra.person_id,
    };
  }

  return { detail: "tracking", pending: false };
}

const VISION_LABEL: Record<LiveState, string> = {
  live: "Live — receiving observations from the vision service",
  connecting: "Connecting to the vision service…",
  down: "No observations. The detector may be down; the record is unaffected.",
};

/**
 * The VISION channel's state, not the node's.
 *
 * `components/ibvap/live-dot.tsx` reports the edge node's SSE stream. These are
 * two independent links that fail for different reasons and have different
 * consequences -- the node going quiet means the record stopped, the detector
 * going quiet means only the overlay did. Showing one where the other is meant
 * would send somebody to restart the wrong process.
 */
function VisionDot({ state }: { state: LiveState }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative flex size-2">
          {state === "live" && (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-500 opacity-60" />
          )}
          <span
            className={cn(
              "relative inline-flex size-2 rounded-full",
              state === "live" && "bg-sky-500",
              state === "connecting" && "bg-amber-500",
              state === "down" && "bg-destructive",
            )}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{VISION_LABEL[state]}</TooltipContent>
    </Tooltip>
  );
}

export function LiveConsole({
  cameraId,
  module,
  title = "Live detections",
  className,
}: {
  cameraId: string;
  module: string;
  title?: string;
  className?: string;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<LiveState>("connecting");
  const [seen, setSeen] = useState(0);
  const buffer = useRef<Line[]>([]);
  const counter = useRef(0);

  useEffect(() => onLiveState(setState), []);

  useEffect(() => {
    buffer.current = [];
    setLines([]);
    setSeen(0);

    const off = onLive(cameraId, module, (observation) => {
      for (const track of observation.tracks) {
        const { detail, pending } = describe(observation.module, track);
        buffer.current.push({
          key: `${counter.current++}`,
          at: observation.frame_ts,
          klass: track.class,
          confidence: track.confidence,
          detail,
          pending,
        });
      }
      if (buffer.current.length > MAX_LINES * 4) {
        buffer.current = buffer.current.slice(-MAX_LINES * 4);
      }
    });

    const timer = setInterval(() => {
      if (buffer.current.length === 0) return;
      const batch = buffer.current;
      buffer.current = [];
      setSeen((n) => n + batch.length);
      // Newest first: an operator glancing at this reads the top line.
      setLines((current) => [...batch.reverse(), ...current].slice(0, MAX_LINES));
    }, FLUSH_MS);

    return () => {
      off();
      clearInterval(timer);
    };
  }, [cameraId, module]);

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px]">
            {seen} seen
          </Badge>
          <VisionDot state={state} />
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-0">
        <ScrollArea className="h-[260px]">
          <div className="flex flex-col gap-px px-4 pb-4 font-mono text-xs">
            {lines.length === 0 && (
              <p className="py-8 text-center text-muted-foreground">
                {state === "live"
                  ? "connected · nothing in frame"
                  : "waiting for the vision service"}
              </p>
            )}
            {lines.map((line) => (
              <div
                key={line.key}
                className={cn(
                  "flex items-baseline gap-2 rounded px-1 py-0.5",
                  line.pending && "bg-amber-500/10",
                )}
              >
                <span className="tabular-nums text-muted-foreground">
                  {line.at.toFixed(1)}
                </span>
                <span className="font-medium">{line.klass}</span>
                <span className="tabular-nums text-muted-foreground">
                  {(line.confidence * 100).toFixed(0)}%
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {line.detail}
                </span>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
