import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  onLive, onLiveState, type AnprExtra, type FenceExtra, type LiveState,
  type LiveTrack, type PeopleExtra,
} from "@/lib/live";
import { cn } from "@/lib/utils";

/**
 * What the detector is seeing on one camera, as it sees it.
 *
 * NOTHING HERE IS A RECORD. Every row is an unconfirmed observation off the
 * live channel: a box that exists this frame, a plate the OCR is currently
 * guessing, a crossing being held but not yet confirmed. The moment one becomes
 * a fact the system keeps, it arrives separately from the node as an incident.
 * Operators must be able to tell the two apart without thinking, so this panel
 * never carries a severity colour, never carries an action button, and says
 * "streaming" rather than anything that sounds like a verdict.
 *
 * THROTTLED ON PURPOSE. Observations arrive at the detector's cadence (about
 * 6/s per camera). Re-rendering a React list that often burns the operator's
 * CPU animating text nobody can read at that speed, so rows accumulate in a ref
 * and flush on an interval. The ref is the buffer; state is only what is
 * painted.
 *
 * ONE ROW PER TRACK, NOT PER FRAME. The earlier version of this appended a line
 * every time it saw a track, so a single car standing still filled the panel
 * with sixty identical rows a second and pushed everything else off the top.
 * Rows are now keyed by track and updated in place, which is why the list is
 * short and the timestamps move.
 *
 * Generic on purpose -- it takes a camera and a module name and nothing else,
 * so any service page can mount it. Only the fence page does today.
 */

const FLUSH_MS = 400;
const MAX_ROWS = 40;

/** How long a track stays listed after its last sighting. */
const STALE_MS = 6000;

interface Row {
  trackRef: string;
  at: number;
  wallClock: number;
  klass: string;
  confidence: number;
  status: string;
  /** True when the module is holding something back pending confirmation. */
  pending: boolean;
}

/** Turn one module's track into the one line worth reading about it. */
function describe(module: string, track: LiveTrack): { status: string; pending: boolean } {
  if (module === "fence") {
    const extra = track.extra as FenceExtra;
    const held = extra.zones?.find((zone) => zone.pending);
    if (held) {
      return {
        status: `${held.direction ?? "crossing"} ${held.name} · holding ${held.held.toFixed(1)}s`,
        pending: true,
      };
    }
    const inside = extra.zones?.filter((zone) => zone.side === 1).map((zone) => zone.name);
    return {
      status: inside?.length ? `inside ${inside.join(", ")}` : "tracking",
      pending: false,
    };
  }

  if (module === "anpr") {
    const extra = track.extra as AnprExtra;
    if (extra.plate) {
      return {
        status: `plate ${extra.plate.text} (${(extra.plate.confidence * 100).toFixed(0)}%, unconfirmed)`,
        pending: true,
      };
    }
    return { status: `${extra.vehicle_type ?? "vehicle"} · no readable plate`, pending: false };
  }

  if (module === "multi_human") {
    const extra = track.extra as PeopleExtra;
    const age = extra.age_seconds ? `${extra.age_seconds.toFixed(0)}s in frame` : "new track";
    // `matched_ref` says which earlier TRACK this resembles. It is never an
    // identity, and the wording here must not imply one.
    return {
      status: extra.matched_ref ? `${age} · resembles ${extra.matched_ref}` : age,
      pending: false,
    };
  }

  return { status: "tracking", pending: false };
}

const VISION_LABEL: Record<LiveState, string> = {
  live: "Streaming — receiving observations from the vision service",
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
        <span className="flex items-center gap-1.5">
          <span className="relative flex size-2">
            {state === "live" && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            )}
            <span
              className={cn(
                "relative inline-flex size-2 rounded-full",
                state === "live" && "bg-emerald-500",
                state === "connecting" && "bg-amber-500",
                state === "down" && "bg-destructive",
              )}
            />
          </span>
          <span
            className={cn(
              "text-xs font-medium",
              state === "live" && "text-emerald-600 dark:text-emerald-400",
              state === "connecting" && "text-amber-600 dark:text-amber-500",
              state === "down" && "text-destructive",
            )}
          >
            {state === "live" ? "Streaming" : state === "connecting" ? "Connecting" : "No signal"}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{VISION_LABEL[state]}</TooltipContent>
    </Tooltip>
  );
}

/** Confidence as a bar, because a column of percentages is not scannable. */
function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span className="flex items-center gap-2">
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {pct}%
      </span>
      <span className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-300",
            // Confidence is the DETECTOR's certainty, never a severity. Kept on
            // one neutral hue so it can never be misread as "how bad is this" --
            // that judgement belongs to the incident panel and its targets.
            pct >= 70 ? "bg-sky-500" : pct >= 50 ? "bg-sky-400" : "bg-sky-300",
          )}
          style={{ width: `${Math.max(4, pct)}%` }}
        />
      </span>
    </span>
  );
}

export function LiveDetections({
  cameraId,
  module,
  title = "Live Detections",
  className,
}: {
  cameraId: string;
  module: string;
  title?: string;
  className?: string;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<LiveState>("connecting");
  const [klass, setKlass] = useState("all");
  const buffer = useRef<Map<string, Row>>(new Map());

  useEffect(() => onLiveState(setState), []);

  useEffect(() => {
    buffer.current = new Map();
    setRows([]);

    const off = onLive(cameraId, module, (observation) => {
      for (const track of observation.tracks) {
        const { status, pending } = describe(observation.module, track);
        // Keyed by track: the same subject updates its own row rather than
        // adding one. `track_ref` where a module publishes it, the numeric id
        // otherwise -- the id alone is reused once a track dies, which would
        // let a new subject inherit an old row.
        const extra = track.extra as { track_ref?: string } | undefined;
        const key = extra?.track_ref ?? String(track.track_id);
        buffer.current.set(key, {
          trackRef: key,
          at: observation.frame_ts,
          wallClock: Date.now(),
          klass: track.class,
          confidence: track.confidence,
          status,
          pending,
        });
      }
    });

    const timer = setInterval(() => {
      const cutoff = Date.now() - STALE_MS;
      for (const [key, row] of buffer.current) {
        // A track that stopped being reported has left the frame. Dropping it
        // keeps the panel a picture of NOW; leaving it would quietly turn this
        // into a history nobody asked for and the incident list already is.
        if (row.wallClock < cutoff) buffer.current.delete(key);
      }
      setRows(
        [...buffer.current.values()]
          .sort((a, b) => b.wallClock - a.wallClock)
          .slice(0, MAX_ROWS),
      );
    }, FLUSH_MS);

    return () => {
      off();
      clearInterval(timer);
    };
  }, [cameraId, module]);

  const classes = useMemo(
    () => [...new Set(rows.map((row) => row.klass))].sort(),
    [rows],
  );
  const shown = klass === "all" ? rows : rows.filter((row) => row.klass === klass);

  return (
    <Card className={cn("flex flex-col overflow-hidden", className)}>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <CardTitle className="truncate text-sm font-semibold">{title}</CardTitle>
          <VisionDot state={state} />
        </div>
        <Select value={klass} onValueChange={setKlass}>
          <SelectTrigger size="sm" className="h-7 w-[130px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All classes</SelectItem>
            {classes.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>

      <CardContent className="flex-1 p-0">
        <div className="grid grid-cols-[72px_84px_minmax(0,1fr)_104px] gap-2 border-y bg-muted/40 px-4 py-1.5 text-[11px] font-medium text-muted-foreground">
          <span>Time</span>
          <span>Class</span>
          <span>Confidence</span>
          <span>Status</span>
        </div>

        <ScrollArea className="h-[268px]">
          {shown.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              {state === "live"
                ? klass === "all"
                  ? "connected · nothing in frame"
                  : `nothing in frame matching ${klass}`
                : "waiting for the vision service"}
            </p>
          ) : (
            <div className="divide-y">
              {shown.map((row) => (
                <div
                  key={row.trackRef}
                  className={cn(
                    "grid grid-cols-[72px_84px_minmax(0,1fr)_104px] items-center gap-2 px-4 py-2 text-xs transition-colors",
                    row.pending && "bg-amber-500/10",
                  )}
                >
                  <span className="tabular-nums text-muted-foreground">
                    {new Date(row.wallClock).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    })}
                  </span>
                  <span className="truncate font-medium">{row.klass}</span>
                  <ConfidenceBar value={row.confidence} />
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        row.pending ? "bg-amber-500" : "bg-emerald-500",
                      )}
                    />
                    <span
                      className="truncate text-muted-foreground"
                      title={row.status}
                    >
                      {row.status}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>

      <div className="border-t px-4 py-1.5 text-[11px] text-muted-foreground">
        Unconfirmed observations, not the record. Anything that becomes a fact
        arrives from the node as an incident.
      </div>
    </Card>
  );
}
