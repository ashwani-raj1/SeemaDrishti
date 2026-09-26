import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  CheckIcon, ChevronLeftIcon, ChevronRightIcon, FilmIcon, ImageIcon, MapIcon,
  SirenIcon, XIcon,
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
import { useClient } from "@/client/context";
import { api, needsReason } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { clockTime, dateTime, humanise, percent, relative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Decision, IbvapEvent, Incident } from "@/lib/types";
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

      {data && incident && (
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
              windowSeconds={(data.crossReference as any)?.windowSeconds}
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
