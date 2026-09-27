import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowRightIcon, CalendarClockIcon, CameraIcon, CarFrontIcon, CheckIcon,
  ChevronLeftIcon, ChevronRightIcon, FilmIcon, ImageIcon, MapIcon, MapPinIcon,
  ShieldAlertIcon, SirenIcon, XIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SeverityBadge, SimulatedBadge, SuppressedBadge, ProvisionalBadge,
} from "@/components/ibvap/badges";
import { EvidenceMap } from "@/components/ibvap/evidence-map";
import { ClipPlayer } from "@/components/ibvap/clip-player";
import { ErrorState, LoadingRows } from "@/components/ibvap/states";
import { PageShell } from "@/components/ibvap/page-shell";
import { HistoryLink } from "@/components/ibvap/history-link";
import { ShareLink } from "@/components/ibvap/share-link";
import { ReasonDialog } from "@/components/ibvap/reason-dialog";
import { EventThumb } from "@/features/services/fence-panels";
import { ATTARI_SECTOR, gridRef } from "@/client/geography";
import { useClient } from "@/client/context";
import { api, needsReason } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { clockTime, dateTime, humanise, percent, relative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Decision, IbvapEvent, Incident, PlateDetection } from "@/lib/types";
import {
  AlsoWatching, CameraInformation, DetectorAnalysis, IncidentDetails,
  RelatedIncidents, ZoneInformation,
} from "./panels";
import { rankIncidents } from "./use-incidents";

/**
 * One incident, at its own address.
 *
 * This used to be a drawer over the queue, which meant an operator saying "look
 * at this one" had nothing to send. A page has a URL: it can be pasted into a
 * handover note, bookmarked, and opened by somebody who was not at the screen
 * when it fired.
 *
 * THE LAYOUT IS AN ARGUMENT ABOUT EVIDENCE. The left column is what happened
 * and how we know -- the ground, the frames, the sequence. The right column is
 * what it was judged against: the zone's rules, the camera's state, what the
 * detector concluded, what else was watching. An operator reading left to right
 * gets the event before the interpretation, which is the order that keeps the
 * two apart in their head.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no speed and no behaviour
 * classification, because this system measures neither and section 7 forbids
 * quoting a figure that was not measured. Those rows exist and say "Not
 * measured yet" rather than being quietly dropped: a visible gap is a to-do,
 * an absent row is a thing nobody remembers is missing, and an invented number
 * is a lie that ends up on a slide.
 *
 * ONE EXCEPTION TO THE LAYOUT. A plate watchlist hit is not a track over
 * ground -- it is a read of a plate against a list, and its evidence is the
 * captured frame plus why that plate is listed. It gets its own case view
 * below rather than being forced through the crossing layout.
 */
export function IncidentPage() {
  const { incidentId } = useParams();
  const navigate = useNavigate();
  const { cameras: known } = useClient();

  const { data, error, loading, reload } = useResource(
    () => (incidentId ? api.incident(incidentId) : Promise.resolve(null)),
    [incidentId],
  );

  const [prompt, setPrompt] = useState<{ decision: Decision } | null>(null);
  const [pending, setPending] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [view, setView] = useState<"ground" | "frames">("frames");

  const incident = data?.incident;
  const events = data?.events ?? [];

  /**
   * The event that best describes the incident.
   *
   * The first ALERTING one, not the newest. An incident's newest event is often
   * the one that was lost before confirming -- the weakest evidence in the
   * set -- and letting that drive the header would describe the whole incident
   * by its least convincing moment.
   */
  const lead = useMemo(
    () => events.find((event) => event.alertable) ?? events[0] ?? null,
    [events],
  );

  /** The clip is attached to whichever event actually recorded one. */
  const clipId = useMemo(
    () => events.map((event) => event.evidence?.clipId).find(Boolean) ?? null,
    [events],
  );

  // The custom evidence workspace belongs only to Plate Watchlist incidents.
  // Other incident modules keep the crossing layout below.
  const watchlistEvent = events.find((event) => event.evidence.type === "watchlist_hit");
  const watchlistPlate = typeof watchlistEvent?.evidence.plateNumber === "string"
    ? watchlistEvent.evidence.plateNumber
    : "";
  const sourceCameraId = watchlistEvent?.cameraId ?? incident?.cameraId ?? "";
  const sourceOccurredAt = watchlistEvent?.occurredAt ?? incident?.openedAt ?? "";

  // Event rows remain append-only. Resolve the linked detection separately so
  // the incident page can show the retained frame without duplicating a large
  // base64 image inside the event/audit record.
  const { data: relatedDetections } = useResource(
    () => watchlistPlate
      ? api.plateDetections({ plate: watchlistPlate, camera_id: sourceCameraId || undefined, limit: 25 })
      : Promise.resolve([] as PlateDetection[]),
    [watchlistPlate, sourceCameraId],
  );
  const closestDetection = (relatedDetections ?? [])
    .slice()
    .sort((a, b) => Math.abs(Date.parse(a.occurred_at) - Date.parse(sourceOccurredAt)) - Math.abs(Date.parse(b.occurred_at) - Date.parse(sourceOccurredAt)))[0];
  const persistedProof = (relatedDetections ?? [])
    .filter((detection) => displayableSnapshot(detection.image_snapshot))
    .sort((a, b) => Math.abs(Date.parse(a.occurred_at) - Date.parse(sourceOccurredAt)) - Math.abs(Date.parse(b.occurred_at) - Date.parse(sourceOccurredAt)))[0];
  const sessionProof = findSessionProof(sourceCameraId, watchlistPlate, sourceOccurredAt);
  const proofDetection = persistedProof ?? sessionProof ?? closestDetection;

  // A zone as this camera sees it, for the rules panel. Read from the client
  // context rather than fetched: it is the same payload the fence overlay uses,
  // so the page cannot disagree with the picture about what the shape is.
  const zone = useMemo(() => {
    if (!incident?.zoneId) return null;
    const camera = known.find((entry) => entry.id === incident.cameraId);
    return camera?.zones.find((z) => z.id === incident.zoneId) ?? null;
  }, [known, incident?.zoneId, incident?.cameraId]);

  const hubCameras = useResource(() => api.mediaCameras(), []);
  const hub = hubCameras.data?.cameras.find((entry) => entry.id === incident?.cameraId);

  // Previous / next through the queue as it is ranked on the list screen, so
  // stepping here walks the same order an operator was just reading.
  const [siblings, setSiblings] = useState<Incident[]>([]);
  useEffect(() => {
    api
      .incidents({ limit: 200 })
      .then((list) => setSiblings(rankIncidents(list)))
      .catch(() => setSiblings([]));
  }, []);

  const position = siblings.findIndex((entry) => entry.id === incidentId);
  const previous = position > 0 ? siblings[position - 1] : null;
  const next = position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : null;

  const decide = useCallback(
    async (decision: Decision, reason?: string) => {
      if (!incident) return;
      setPending(true);
      try {
        await api.decide(incident.id, decision, reason);
        toast.success(`Incident ${decision}d`, { description: incident.title });
        setPrompt(null);
        setReasonError(null);
        reload();
      } catch (cause) {
        // The node requires a stated reason for escalate and dismiss and says
        // so with a 422. Open the dialog rather than swallowing it.
        if (needsReason(cause)) {
          setReasonError((cause as Error).message);
          setPrompt({ decision });
        } else {
          toast.error((cause as Error).message);
        }
      } finally {
        setPending(false);
      }
    },
    [incident, reload],
  );

  return (
    <PageShell
      title={incident?.title ?? "Incident"}
      description={
        incident
          ? `Opened ${dateTime(incident.openedAt)} · ${incident.eventCount} event${incident.eventCount === 1 ? "" : "s"}`
          : "Loading the full chain of accountability…"
      }
      breadcrumbs={[{ label: "Incidents", to: "/incidents" }]}
      actions={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!previous}
            onClick={() => previous && navigate(`/incidents/${previous.id}`)}
          >
            <ChevronLeftIcon className="size-4" /> Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!next}
            onClick={() => next && navigate(`/incidents/${next.id}`)}
          >
            Next <ChevronRightIcon className="size-4" />
          </Button>
          <ShareLink />
        </div>
      }
      toolbar={
        incident && (
          <div className="flex flex-wrap items-center gap-2">
            {incident.number != null && (
              <Badge variant="outline" className="font-mono text-xs">
                #{incident.number}
              </Badge>
            )}
            <SeverityBadge severity={incident.severity} />
            <Badge variant="outline" className="font-mono text-xs">
              {incident.status}
            </Badge>
            {/* An incident exists for every event, alerted or not. Saying which
                this is matters more than its severity: "CRITICAL, recorded
                only" is a real and confusing state. */}
            {!incident.alertable && (
              <Badge variant="secondary" className="text-xs">
                recorded, never alerted
              </Badge>
            )}
            {lead?.source.simulated && <SimulatedBadge />}
            {lead?.evidence?.provisional && <ProvisionalBadge />}
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {incident.id}
            </span>
          </div>
        )
      }
    >
      {loading && !data && <LoadingRows rows={4} />}
      {error && <ErrorState error={error} onRetry={reload} />}

      {data && incident && watchlistEvent && (
        <WatchlistHitCase
          incident={incident}
          event={watchlistEvent}
          detection={proofDetection}
        />
      )}

      {data && incident && !watchlistEvent && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* ── left: what happened, and how we know ────────────────── */}
          <div className="space-y-4">
            <Card className="gap-0 overflow-hidden p-0">
              <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 border-b p-4">
                <div className="min-w-0">
                  <CardTitle className="text-sm font-semibold">Evidence</CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {view === "frames"
                      ? "The frames the detector judged, either side of the crossing."
                      : "Track and crossing point projected onto the ground from the camera's bearing and range."}
                  </p>
                </div>
                <Tabs value={view} onValueChange={(next) => setView(next as typeof view)}>
                  <TabsList className="h-8">
                    <TabsTrigger value="frames" className="gap-1.5 text-xs">
                      <FilmIcon className="size-3.5" /> Frames
                    </TabsTrigger>
                    <TabsTrigger value="ground" className="gap-1.5 text-xs">
                      <MapIcon className="size-3.5" /> Ground
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </CardHeader>
              <CardContent className="p-4">
                {view === "ground" ? (
                  lead ? (
                    <EvidenceMap event={lead} className="aspect-video w-full" />
                  ) : (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      No event to draw.
                    </p>
                  )
                ) : clipId ? (
                  <ClipPlayer clipId={clipId} />
                ) : (
                  <NoClip event={lead} />
                )}
              </CardContent>
            </Card>

            <Timeline events={events} actions={data.actions} />
          </div>

          {/* ── right: what it was judged against ───────────────────── */}
          <div className="space-y-4">
            <Card className="gap-0 p-4">
              <CardTitle className="mb-3 text-sm font-semibold">Decide</CardTitle>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  disabled={pending || incident.status === "ACKNOWLEDGED"}
                  onClick={() => void decide("acknowledge")}
                >
                  <CheckIcon className="size-4" />
                  {incident.status === "ACKNOWLEDGED" ? "Acknowledged" : "Acknowledge"}
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setReasonError(null);
                    setPrompt({ decision: "escalate" });
                  }}
                >
                  <SirenIcon className="size-4" /> Escalate
                </Button>
                <Button
                  variant="ghost"
                  className="col-span-2"
                  disabled={pending}
                  onClick={() => {
                    setReasonError(null);
                    setPrompt({ decision: "dismiss" });
                  }}
                >
                  <XIcon className="size-4" /> Dismiss
                </Button>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                Escalating and dismissing need a stated reason. Nothing here
                deletes anything — the decision is recorded beside the event.
              </p>
            </Card>

            <IncidentDetails
              incident={incident}
              event={lead}
              camera={data.camera}
              zoneName={data.crossReference?.zone?.name}
            />
            <ZoneInformation zone={zone} />
            <CameraInformation camera={data.camera} hub={hub} />
            <DetectorAnalysis event={lead} />
            <AlsoWatching cameras={data.crossReference?.cameras ?? []} />
            <RelatedIncidents
              incidents={data.crossReference?.incidents ?? []}
              windowSeconds={data.crossReference?.windowSeconds}
            />

            <div className="flex flex-wrap gap-4 px-1">
              <HistoryLink zoneId={incident.zoneId} label="Every event on this zone" />
              <HistoryLink cameraId={incident.cameraId} label="Every event on this camera" />
            </div>
          </div>
        </div>
      )}

      <ReasonDialog
        open={prompt !== null}
        title={prompt?.decision === "escalate" ? "Escalate incident" : "Dismiss incident"}
        description={incident?.title ?? ""}
        confirmLabel={prompt?.decision === "escalate" ? "Escalate" : "Dismiss"}
        destructive={prompt?.decision === "dismiss"}
        pending={pending}
        error={reasonError}
        onOpenChange={(open) => !open && setPrompt(null)}
        onConfirm={(reason) => prompt && void decide(prompt.decision, reason)}
      />
    </PageShell>
  );
}

/**
 * What to show when there are no frames, said precisely.
 *
 * Four different reasons produce no clip and they are not the same: clips were
 * never enabled on this camera, the clip was shed under load, retention took
 * it, or this event was a lost track with nothing to cut. The stored
 * single-frame thumbnail is shown when there is one, because a still is a great
 * deal better than a placeholder.
 */
function NoClip({ event }: { event: IbvapEvent | null }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      {event?.hasThumbnail ? (
        <EventThumb event={event} className="aspect-video w-full max-w-lg" />
      ) : (
        <ImageIcon className="size-8 text-muted-foreground" />
      )}
      <p className="max-w-md text-xs text-muted-foreground">
        {event?.hasThumbnail
          ? "One stored frame, cut at the crossing. No clip was recorded for this camera — clips are opt-in per camera and kept for a shorter window than the record."
          : "No frames were kept for this crossing. The event itself is unaffected; clips and thumbnails are evidence, not the record."}
      </p>
    </div>
  );
}

/**
 * The sequence, as it actually happened.
 *
 * EVENTS AND DECISIONS INTERLEAVED, because the question this answers is "what
 * happened and what did we do about it", and splitting those into two tabs made
 * an operator hold the times in their head to line them up.
 *
 * The rows are the REAL events. There is no "entered zone" or "auto-closed"
 * step: the detector emits confirmed crossings and lost tracks, and incidents
 * are closed by a person, never by a timer. Inventing intermediate steps would
 * make the timeline read as a richer record than the one that exists.
 */
function Timeline({
  events,
  actions,
}: {
  events: IbvapEvent[];
  actions: Array<{ id: string; verb: string; at: string; reason: string | null; actor: { name: string; role: string }; hash: string }>;
}) {
  const rows = useMemo(() => {
    const merged: Array<
      | { kind: "event"; at: string; event: IbvapEvent }
      | { kind: "action"; at: string; action: (typeof actions)[number] }
    > = [
      ...events.map((event) => ({ kind: "event" as const, at: event.occurredAt, event })),
      ...actions.map((action) => ({ kind: "action" as const, at: action.at, action })),
    ];
    return merged.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }, [events, actions]);

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <CardHeader className="border-b p-4">
        <CardTitle className="text-sm font-semibold">
          What happened ({events.length} event{events.length === 1 ? "" : "s"},{" "}
          {actions.length} decision{actions.length === 1 ? "" : "s"})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {rows.map((row) =>
            row.kind === "event" ? (
              <EventRow key={row.event.id} event={row.event} />
            ) : (
              <div key={row.action.id} className="flex gap-3 bg-muted/30 p-3">
                <div className="mt-1 size-2 shrink-0 rounded-full bg-sky-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {row.action.verb}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {row.action.actor.name} · {row.action.actor.role}
                    </span>
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                      {clockTime(row.action.at)}
                    </span>
                  </div>
                  {row.action.reason && (
                    <p className="mt-1 text-sm">“{row.action.reason}”</p>
                  )}
                  {/* The chain link. What makes this a record rather than a note. */}
                  <code className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">
                    {row.action.hash.slice(0, 32)}…
                  </code>
                </div>
              </div>
            ),
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EventRow({ event }: { event: IbvapEvent }) {
  const evidence = event.evidence ?? {};

  return (
    <div className="flex gap-3 p-3">
      <div
        className={cn(
          "mt-1 size-2 shrink-0 rounded-full",
          event.alertable ? "bg-destructive" : "bg-muted-foreground/40",
        )}
      />
      <EventThumb event={event} className="h-12 w-[68px] shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {event.class ? humanise(event.class) : humanise(event.kind)}
            {event.direction && (
              <span className="text-muted-foreground"> · {event.direction}</span>
            )}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">seq {event.seq}</span>
          {event.source.simulated && <SimulatedBadge />}
          {!event.alertable && event.suppressedReason && (
            <SuppressedBadge reason={event.suppressedReason} />
          )}
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
            {clockTime(event.occurredAt)}
            <span className="ml-1 opacity-70">{relative(event.occurredAt)}</span>
          </span>
        </div>
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
          {event.rule && <span className="font-mono">{event.rule}</span>}
          {event.confidence != null && <span>{percent(event.confidence)}</span>}
          {evidence.confirmSeconds !== undefined && (
            <span>
              held {evidence.heldSeconds ?? "?"}s of {evidence.confirmSeconds}s
            </span>
          )}
          {evidence.zone?.name && <span>{evidence.zone.name}</span>}
        </dl>
      </div>
    </div>
  );
}

// ---- plate watchlist case view ---------------------------------------
// A plate read judged against a list, rather than a track judged against a
// zone. Everything below serves that one incident kind.

function evidenceText(event: IbvapEvent, key: string): string | null {
  const value = event.evidence[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function evidenceNumber(event: IbvapEvent, key: string): number | null {
  const value = event.evidence[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function displayableSnapshot(value: string | null | undefined): value is string {
  return Boolean(value && (
    value.startsWith("data:image/") || value.startsWith("blob:") ||
    value.startsWith("http://") || value.startsWith("https://") || value.startsWith("/")
  ));
}

function normalisePlate(value: string | null | undefined): string {
  return (value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function findSessionProof(cameraId: string, plateNumber: string, occurredAt: string): PlateDetection | undefined {
  if (typeof window === "undefined" || !cameraId || !plateNumber) return undefined;
  try {
    const raw = window.localStorage.getItem("ibvap:anpr-camera-sessions:v3");
    if (!raw) return undefined;
    const sessions = JSON.parse(raw) as Record<string, { vehicles?: PlateDetection[] }>;
    const target = normalisePlate(plateNumber);
    const targetTime = Date.parse(occurredAt);
    return (sessions[cameraId]?.vehicles ?? [])
      .filter((detection) =>
        normalisePlate(detection.plate_number) === target && displayableSnapshot(detection.image_snapshot))
      .sort((a, b) => {
        if (!Number.isFinite(targetTime)) return Date.parse(b.occurred_at) - Date.parse(a.occurred_at);
        return Math.abs(Date.parse(a.occurred_at) - targetTime) - Math.abs(Date.parse(b.occurred_at) - targetTime);
      })[0];
  } catch {
    return undefined;
  }
}

function WatchlistHitCase({
  incident,
  event,
  detection,
}: {
  incident: Incident;
  event: IbvapEvent;
  detection?: PlateDetection;
}) {
  const plateNumber = evidenceText(event, "plateNumber") ?? detection?.plate_number ?? "Unread plate";
  const vehicleType = evidenceText(event, "vehicleType") ?? detection?.vehicle_type ?? "Vehicle";
  const makeModel = evidenceText(event, "makeModel");
  const color = evidenceText(event, "color");
  const reason = evidenceText(event, "flagReason") ?? event.rule ?? "Active watchlist match";
  const notes = evidenceText(event, "notes");
  const cameraId = event.cameraId ?? incident.cameraId;
  const cameraName = evidenceText(event, "cameraName") ?? detection?.camera_name ?? cameraId ?? "Unknown camera";
  const zoneName = evidenceText(event, "zoneName") ?? detection?.zone_name ?? event.evidence.zone?.name ?? "Camera coverage area";
  const placement = cameraId ? ATTARI_SECTOR.cameras[cameraId] : undefined;
  const grid = placement ? gridRef(placement.at, ATTARI_SECTOR) : "—";
  const plateConfidence = evidenceNumber(event, "plateConfidence") ?? detection?.plate_confidence ?? event.confidence;
  const matchConfidence = evidenceNumber(event, "matchConfidence");
  const exactMatch = event.evidence.exactMatch === true;
  const snapshot = displayableSnapshot(detection?.image_snapshot) ? detection.image_snapshot : null;
  const watchlistUrl = `/watchlist?camera=${encodeURIComponent(cameraId ?? "")}&plate=${encodeURIComponent(plateNumber)}&at=${encodeURIComponent(event.occurredAt)}`;

  return (
    <section className="space-y-4" aria-label="Watchlist hit case details">
      <div className="overflow-hidden rounded-xl border border-red-500/35 bg-red-500/[0.045] shadow-sm">
        <div className="flex flex-col gap-3 bg-red-600 px-4 py-3 text-white sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
              <ShieldAlertIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-red-100">Watchlist hit confirmed</div>
              <div className="truncate font-mono text-lg font-black tracking-[0.12em] sm:text-xl">{plateNumber}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="secondary" className="font-semibold text-red-700">
              <Link to={watchlistUrl}>
                Open focused ANPR <ArrowRightIcon data-icon="inline-end" />
              </Link>
            </Button>
            {cameraId && (
              <Button asChild size="sm" variant="outline" className="border-white/40 bg-white/10 text-white hover:bg-white/20 hover:text-white">
                <Link to={`/cameras/${cameraId}`}>Camera record</Link>
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <CaseFact icon={CalendarClockIcon} label="When" value={dateTime(event.occurredAt)} detail={clockTime(event.occurredAt)} />
          <CaseFact icon={MapPinIcon} label="Where" value={zoneName} detail={`Grid ${grid}`} />
          <CaseFact icon={CameraIcon} label="Camera" value={cameraName} detail={cameraId ?? "Source unavailable"} />
          <CaseFact icon={CarFrontIcon} label="Vehicle" value={[color, makeModel].filter(Boolean).join(" · ") || humanise(vehicleType)} detail={humanise(vehicleType)} />
        </div>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
        <Card className="min-w-0 overflow-hidden py-0">
          <CardHeader className="border-b px-4 py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ImageIcon className="h-4 w-4 text-blue-600" /> Captured proof
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {snapshot ? (
              <div className="overflow-hidden rounded-lg border bg-slate-950">
                <img src={snapshot} alt={`ANPR evidence for ${plateNumber}`} className="max-h-[28rem] w-full object-contain" />
              </div>
            ) : (
              <div className="flex aspect-video min-h-52 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/25 px-6 text-center">
                <ImageIcon className="h-8 w-8 text-muted-foreground/60" />
                <div className="text-sm font-semibold">Captured frame is not available</div>
                <div className="max-w-md text-xs leading-5 text-muted-foreground">
                  This retained or simulated record did not include source pixels. Real Watchlist hits show the captured plate or vehicle crop here when the camera supplies a frame.
                </div>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>Evidence ID: <strong className="font-mono text-foreground">{evidenceText(event, "detectionId") ?? detection?.id ?? event.id}</strong></span>
              <span className="font-mono">Captured {dateTime(event.occurredAt)}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 py-0">
          <CardHeader className="border-b px-4 py-3">
            <CardTitle className="text-sm">Incident explanation & response</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            <div className="rounded-lg border border-red-500/25 bg-red-500/[0.05] p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-red-600">Watchlist reason</div>
              <p className="mt-1 text-sm font-semibold leading-5 text-red-800 dark:text-red-200">{reason}</p>
            </div>
            <div className="rounded-lg border bg-muted/25 p-3 text-xs leading-5 text-muted-foreground">
              <div className="font-semibold text-foreground">What happened</div>
              <p className="mt-1">
                ANPR read <strong className="font-mono text-foreground">{plateNumber}</strong> at {cameraName} on {dateTime(event.occurredAt)}.
                {exactMatch
                  ? " After removing spaces and separators, it exactly matched an active Plate Watchlist record."
                  : " The normalized OCR reading matched an active Plate Watchlist record using the configured OCR-confusion rules."}
              </p>
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/[0.04] p-3 text-xs leading-5 text-muted-foreground">
              <div className="font-semibold text-foreground">Recommended supervisor action</div>
              <p className="mt-1">
                Open the focused ANPR view, confirm the plate against the captured proof, then follow the watchlist reason and supervisor instruction. Confidence values describe the OCR read, not the identity of the driver.
              </p>
            </div>
            {notes && (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">Supervisor instruction</div>
                <p className="mt-1 text-xs leading-5">{notes}</p>
              </div>
            )}
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <Fact label="Detected plate" value={plateNumber} mono />
              <Fact label="Listed plate" value={evidenceText(event, "watchlistPlate") ?? plateNumber} mono />
              <Fact label="OCR confidence" value={percent(plateConfidence)} mono />
              <Fact label="Match confidence" value={percent(matchConfidence)} mono />
              <Fact label="Match method" value={exactMatch ? "Exact plate match" : "OCR-tolerant match"} />
              <Fact label="Severity" value={incident.severity} mono />
            </dl>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function CaseFact({ icon: Icon, label, value, detail }: { icon: typeof CameraIcon; label: string; value: string; detail: string }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-lg border bg-background/80 p-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="truncate text-sm font-semibold" title={value}>{value}</div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={detail}>{detail}</div>
      </div>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "truncate font-mono" : "truncate"}>{value}</dd>
    </div>
  );
}
