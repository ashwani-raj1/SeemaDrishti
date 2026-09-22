import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  BellRingIcon, CheckIcon, PlusIcon, ShieldAlertIcon, TriangleAlertIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { apiUrl } from "@/lib/api";
import { relative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { IbvapEvent, Incident, Severity, Zone } from "@/lib/types";

/**
 * What these panels need from a zone, and nothing more.
 *
 * `Zone` (as a camera carries it) and `CameraZone` (as the zones screen does)
 * describe the same thing with different field names -- `provisional` on one,
 * `!placed` on the other. Depending on the narrower shape here would force a
 * cast at the call site, which is how a missing field reaches the browser as a
 * crash instead of a type error.
 */
type FenceZone = Pick<Zone, "id" | "name" | "geometry" | "severity" | "provisional">;

/**
 * The panels either side of the fence page's video.
 *
 * Kept out of `fence.tsx` so that file stays a layout and this one stays the
 * detail. Nothing here fetches -- every panel is handed the events, incidents
 * and zones the page already loaded, because four panels each fetching the
 * same 24 hours of events would be four times the work for one screen.
 */

// ── evidence thumbnails ──────────────────────────────────────────────────

/**
 * The frame an event was judged on, or its geometry when there is none.
 *
 * NO PLACEHOLDER IMAGE. `hasThumbnail` false is a real and common state -- the
 * simulator posts no picture, and an event about a LOST track has no current
 * frame by definition. A grey rectangle would make "no picture was ever taken"
 * look identical to "the picture failed to load", so the fallback says which
 * one it is in words.
 *
 * `loading="lazy"` because a list of twenty events would otherwise fetch twenty
 * JPEGs to show six. The node serves them immutable and cached for a year, so
 * scrolling back up costs nothing.
 */
export function EventThumb({
  event,
  className,
}: {
  event: IbvapEvent;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!event.hasThumbnail || failed) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded border border-dashed bg-muted/40 text-center",
          className,
        )}
      >
        <span className="px-1 text-[9px] leading-tight text-muted-foreground">
          {failed ? "picture unavailable" : "no picture"}
        </span>
      </div>
    );
  }

  return (
    <img
      src={apiUrl(`/api/events/${event.id}/thumbnail`)}
      alt={`${event.class ?? "detection"} at ${new Date(event.occurredAt).toLocaleTimeString()}`}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("rounded border object-cover", className)}
    />
  );
}

// ── the alert that wants a decision ──────────────────────────────────────

const SEVERITY_RING: Record<Severity, string> = {
  CRITICAL: "border-destructive/40 bg-destructive/5",
  WARNING: "border-amber-500/40 bg-amber-500/5",
  INFO: "border-border bg-muted/30",
};

/**
 * The one incident that most wants a human, and the two things they can do.
 *
 * Only OPEN and ACKNOWLEDGED incidents appear. A dismissed or escalated one has
 * already had its decision and belongs in history -- leaving it here would mean
 * the loudest panel on the page is showing something nobody needs to act on,
 * which is how operators learn to stop looking at it.
 */
export function ActiveAlert({
  incident,
  raised,
  event,
  zoneName,
  cameraName,
  pending,
  onDecide,
}: {
  incident: Incident | null;
  /**
   * Whether any event in this incident was actually alertable.
   *
   * False means the system recorded it and deliberately told nobody -- an
   * animal on the fence line, a shape nobody drew, a track lost before it
   * confirmed. It is still worth showing, and it still keeps its severity,
   * but calling it an alert would claim a decision the node never made.
   */
  raised: boolean;
  /** The event that opened it, for the picture. */
  event: IbvapEvent | null;
  zoneName?: string;
  cameraName: string;
  pending: boolean;
  onDecide: (incident: Incident, decision: "acknowledge" | "escalate") => void;
}) {
  if (!incident) {
    return (
      <Card className="gap-0 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <ShieldAlertIcon className="size-4" />
          No active alert
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Nothing on this camera is waiting for a decision. Crossings that are
          recorded but not alerted on stay in the event list below.
        </p>
      </Card>
    );
  }

  return (
    <Card
      className={cn(
        "gap-0 border p-4",
        raised ? SEVERITY_RING[incident.severity] : "bg-muted/30",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "flex items-center gap-2 text-sm font-semibold",
            raised ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <BellRingIcon className="size-4" />
          {raised ? "Active Alert" : "Recorded, not alerted"}
        </span>
        <Badge
          variant={raised ? "destructive" : "secondary"}
          className="gap-1 text-[10px] font-bold uppercase"
        >
          {raised && <span className="size-1.5 animate-pulse rounded-full bg-white" />}
          {incident.severity}
        </Badge>
      </div>

      {!raised && (
        // The single most useful sentence on this panel when it is quiet: it
        // says the system saw something, judged it, and chose not to shout --
        // which is a very different state from "nothing happened".
        <p className="mt-2 rounded bg-background/60 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
          Every event in this incident was written to the record without raising
          an alert. Nothing here is waiting on you; the buttons below still work
          if you want it marked.
        </p>
      )}

      <Link to={`/incidents/${incident.id}`} className="mt-3 block hover:underline">
        <p className="text-base font-semibold leading-snug">{incident.title}</p>
      </Link>
      <p className="mt-1 text-xs text-muted-foreground">
        {cameraName}
        {zoneName && <> · Zone: {zoneName}</>}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {new Date(incident.lastEventAt).toLocaleString([], {
          day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        })}
        {incident.eventCount > 1 && ` · ${incident.eventCount} events`}
      </p>

      {event && <EventThumb event={event} className="mt-3 aspect-video w-full" />}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          disabled={pending || incident.status === "ACKNOWLEDGED"}
          onClick={() => onDecide(incident, "acknowledge")}
          className={cn(raised && "bg-destructive text-white hover:bg-destructive/90")}
          variant={raised ? "default" : "outline"}
        >
          <CheckIcon className="size-4" />
          {incident.status === "ACKNOWLEDGED" ? "Acknowledged" : "Acknowledge"}
        </Button>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => onDecide(incident, "escalate")}
        >
          <TriangleAlertIcon className="size-4" />
          Escalate
        </Button>
      </div>
    </Card>
  );
}

// ── what has happened recently ───────────────────────────────────────────

const DOT: Record<Severity, string> = {
  CRITICAL: "bg-destructive",
  WARNING: "bg-amber-500",
  INFO: "bg-sky-500",
};

export function RecentEvents({
  events,
  zoneNames,
  cameraId,
}: {
  events: IbvapEvent[];
  zoneNames: Map<string, string>;
  cameraId: string;
}) {
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b p-4">
        <CardTitle className="text-sm font-semibold">Recent Events</CardTitle>
        <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
          <Link to={`/history?camera_id=${cameraId}`}>View all →</Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {events.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-muted-foreground">
            Nothing recorded on this camera yet.
          </p>
        ) : (
          <div className="divide-y">
            {events.slice(0, 6).map((event) => (
              <Link
                key={event.id}
                to={event.incidentId ? `/incidents/${event.incidentId}` : "/history"}
                className="flex gap-3 p-3 transition-colors hover:bg-accent/50"
              >
                <EventThumb event={event} className="h-12 w-[68px] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                      <span className={cn("size-1.5 shrink-0 rounded-full", DOT[event.severity])} />
                      <span className="truncate">{titleOf(event)}</span>
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {new Date(event.occurredAt).toLocaleTimeString([], {
                        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
                      })}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <Badge variant="secondary" className="h-5 gap-1 font-normal">
                      {event.class ?? "object"}
                      {event.confidence != null && (
                        <span className="tabular-nums text-muted-foreground">
                          {Math.round(event.confidence * 100)}%
                        </span>
                      )}
                    </Badge>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {event.zoneId ? `Zone: ${zoneNames.get(event.zoneId) ?? "—"}` : "no zone"}
                    </span>
                  </div>
                  {/* Why this one never woke anybody. The most useful line on
                      the row when somebody asks "why did nothing happen". */}
                  {!event.alertable && event.suppressedReason && (
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      logged only · {event.suppressedReason.replace(/_/g, " ")}
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function titleOf(event: IbvapEvent): string {
  if (event.kind !== "zone_crossing") return event.kind.replace(/_/g, " ");
  if (!event.alertable) return "Logged crossing";
  return event.direction === "inbound" ? "Intrusion Detected" : "Line Crossing";
}

// ── the zones this camera watches ────────────────────────────────────────

export function ZoneList({ zones }: { zones: FenceZone[] }) {
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b p-4">
        <CardTitle className="text-sm font-semibold">Zones (Virtual Fence)</CardTitle>
        <Button asChild size="sm" variant="outline" className="h-7 text-xs">
          <Link to="/zones">Edit zones</Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {zones.length === 0 ? (
          // Not an error, and worth saying precisely: a camera with no zone is
          // watched but judged against nothing, so it will never produce an
          // intrusion however much crosses it.
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            No zone is bound to this camera, so nothing on it can be judged as a
            crossing. <Link to="/zones" className="underline">Draw one</Link>.
          </p>
        ) : (
          <div className="divide-y">
            {zones.map((zone) => (
              <div key={zone.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    zone.provisional ? "bg-muted-foreground/40" : DOT[zone.severity],
                  )}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{zone.name}</span>
                <span className="w-16 shrink-0 text-xs text-muted-foreground">
                  {zone.geometry}
                </span>
                {/* "Active" here means DRAWN, not enabled. An undrawn shape is
                    still evaluated -- it just never alerts -- so calling it
                    inactive would be a lie in the other direction. */}
                <span
                  className={cn(
                    "w-20 shrink-0 text-right text-xs font-medium",
                    zone.provisional
                      ? "text-amber-600 dark:text-amber-500"
                      : "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {zone.provisional ? "Not drawn" : "Active"}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── when things happened ─────────────────────────────────────────────────

const TIMELINE_HOURS = 24;

/**
 * Every crossing of the last day, one lane per zone.
 *
 * Deliberately not a count-per-hour bar chart. The question this answers is
 * "when does this fence get crossed", and a bar chart of hourly totals hides
 * the thing that matters -- six crossings in four minutes and six spread over
 * an hour are the same bar and very different nights.
 */
export function IntrusionTimeline({
  events,
  zones,
  zoneNames,
}: {
  events: IbvapEvent[];
  zones: FenceZone[];
  zoneNames: Map<string, string>;
}) {
  const [filter, setFilter] = useState("all");
  const now = Date.now();
  const start = now - TIMELINE_HOURS * 3600_000;

  const lanes = useMemo(() => {
    const byZone = new Map<string, IbvapEvent[]>();
    for (const zone of zones) byZone.set(zone.id, []);
    for (const event of events) {
      if (!event.zoneId) continue;
      if (Date.parse(event.occurredAt) < start) continue;
      if (!byZone.has(event.zoneId)) byZone.set(event.zoneId, []);
      byZone.get(event.zoneId)!.push(event);
    }
    return [...byZone.entries()].filter(([id]) => filter === "all" || id === filter);
  }, [events, zones, filter, start]);

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b p-4">
        <CardTitle className="text-sm font-semibold">
          Intrusion Timeline (Last 24 Hours)
        </CardTitle>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger size="sm" className="h-7 w-[140px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All zones</SelectItem>
            {zones.map((zone) => (
              <SelectItem key={zone.id} value={zone.id}>
                {zone.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>

      <CardContent className="p-4">
        {lanes.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No zones on this camera.
          </p>
        ) : (
          <>
            <div className="space-y-2.5">
              {lanes.map(([zoneId, list]) => (
                <div key={zoneId} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-right text-xs text-muted-foreground">
                    {zoneNames.get(zoneId) ?? zoneId}
                  </span>
                  <div className="relative h-7 flex-1 rounded bg-muted/50">
                    {list.map((event) => {
                      const at = (Date.parse(event.occurredAt) - start) / (TIMELINE_HOURS * 3600_000);
                      return (
                        <span
                          key={event.id}
                          title={`${event.class ?? "object"} ${event.direction ?? ""} · ${new Date(event.occurredAt).toLocaleTimeString()}${event.alertable ? "" : " (logged only)"}`}
                          style={{ left: `${Math.min(99.4, Math.max(0, at * 100))}%` }}
                          className={cn(
                            "absolute top-1 h-5 w-[3px] rounded-full",
                            DOT[event.severity],
                            // A suppressed crossing is real and belongs on the
                            // timeline, but it must not read as loud as one
                            // that woke somebody.
                            !event.alertable && "opacity-40",
                          )}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-2 flex justify-between pl-[124px] text-[10px] tabular-nums text-muted-foreground">
              {["24h ago", "18h", "12h", "6h", "now"].map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── notes ────────────────────────────────────────────────────────────────

const NOTES_KEY = "ibvap.fence.notes";

interface Note {
  id: string;
  body: string;
  at: string;
}

/**
 * Operator notes -- ON THIS BROWSER ONLY, and the panel says so.
 *
 * There is no notes table and no endpoint; these live in `localStorage`. That
 * makes them a scratchpad, not a handover: they are invisible to the next
 * shift, to every other terminal, and to the audit log. The label is not
 * decoration -- a note somebody believed was shared, that nobody else could
 * see, is worse than no note at all, so the panel states its own limits rather
 * than looking like the rest of the console.
 */
export function UserNotes({ cameraId }: { cameraId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const key = `${NOTES_KEY}.${cameraId}`;

  useEffect(() => {
    try {
      setNotes(JSON.parse(localStorage.getItem(key) ?? "[]"));
    } catch {
      // A private window, cleared site data, or a value some earlier version
      // wrote in a different shape. An unreadable scratchpad is an empty one.
      setNotes([]);
    }
    setDraft("");
    setAdding(false);
  }, [key]);

  const save = (next: Note[]) => {
    setNotes(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* storage full or blocked; the note stays on screen for this session */
    }
  };

  const add = () => {
    const body = draft.trim();
    if (!body) return;
    save([{ id: `${Date.now()}`, body, at: new Date().toISOString() }, ...notes].slice(0, 20));
    setDraft("");
    setAdding(false);
  };

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b p-4">
        <CardTitle className="text-sm font-semibold">User Notes</CardTitle>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => setAdding((current) => !current)}
        >
          <PlusIcon className="size-3.5" /> Add note
        </Button>
      </CardHeader>

      <CardContent className="space-y-3 p-4">
        {adding && (
          <div className="flex gap-2">
            <Input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && add()}
              placeholder="e.g. increased sensitivity after repeated attempts"
              className="h-8 text-xs"
            />
            <Button size="sm" className="h-8" onClick={add} disabled={!draft.trim()}>
              Save
            </Button>
          </div>
        )}

        {notes.length === 0 && !adding && (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No notes yet.
          </p>
        )}

        {notes.map((note) => (
          <div key={note.id} className="flex gap-2.5 rounded-md bg-muted/40 p-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background text-[10px] font-semibold">
              ME
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-snug">{note.body}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {new Date(note.at).toLocaleString([], {
                  day: "2-digit", month: "short", year: "numeric",
                  hour: "2-digit", minute: "2-digit", hour12: false,
                })}
                {" · "}
                {relative(note.at)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => save(notes.filter((entry) => entry.id !== note.id))}
              className="shrink-0 self-start text-[10px] text-muted-foreground hover:text-destructive"
            >
              remove
            </button>
          </div>
        ))}

        <p className="border-t pt-2.5 text-[10px] leading-snug text-muted-foreground">
          Saved in this browser only. Not shared with other terminals, not part
          of the record, and not in the audit log.
        </p>
      </CardContent>
    </Card>
  );
}
