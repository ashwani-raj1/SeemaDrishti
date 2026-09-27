import { Link, useParams } from "react-router-dom";
import {
  ArrowRightIcon,
  CalendarClockIcon,
  CameraIcon,
  CarFrontIcon,
  CctvIcon,
  ImageIcon,
  MapPinIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SeverityBadge, SimulatedBadge, SuppressedBadge } from "@/components/ibvap/badges";
import { EvidenceMap } from "@/components/ibvap/evidence-map";
import { ErrorState, LoadingRows } from "@/components/ibvap/states";
import { PageShell } from "@/components/ibvap/page-shell";
import { ShareLink } from "@/components/ibvap/share-link";
import { ATTARI_SECTOR, gridRef } from "@/client/geography";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { clockTime, dateTime, humanise, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Action, CrossReference, IbvapEvent, Incident, PlateDetection } from "@/lib/types";

/**
 * One incident, at its own address.
 *
 * This used to be a drawer over the queue, which meant an operator saying
 * "look at this one" had nothing to send. A page has a URL: it can be pasted
 * into a handover note, bookmarked, and opened by somebody who was not at the
 * screen when it fired.
 */
export function IncidentPage() {
  const { incidentId } = useParams();

  const { data, error, loading, reload } = useResource(
    () => (incidentId ? api.incident(incidentId) : Promise.resolve(null)),
    [incidentId],
  );

  const incident = data?.incident;
  // The custom evidence workspace belongs only to Plate Watchlist incidents.
  // Other incident modules retain their generic investigation tabs.
  const watchlistEvent = data?.events.find((event) => event.evidence.type === "watchlist_hit");
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

  return (
    <PageShell
      title={incident?.title ?? "Incident"}
      description={
        incident
          ? `Opened ${dateTime(incident.openedAt)} · ${incident.eventCount} event${incident.eventCount === 1 ? "" : "s"}`
          : "Loading the full chain of accountability…"
      }
      breadcrumbs={[{ label: "Incidents", to: "/incidents" }]}
      actions={<ShareLink />}
      toolbar={
        incident && (
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={incident.severity} />
            <Badge variant="outline" className="font-mono text-xs">
              {incident.status}
            </Badge>
            <Badge variant="secondary" className="font-mono text-xs">
              {incident.id}
            </Badge>
          </div>
        )
      }
    >
      {loading && !data && <LoadingRows rows={4} />}
      {error && <ErrorState error={error} onRetry={reload} />}

      {data && (
        <>
          <Separator />
          {watchlistEvent && incident && (
            <WatchlistHitCase
              incident={incident}
              event={watchlistEvent}
              detection={proofDetection}
            />
          )}
          {!watchlistEvent && <Tabs defaultValue="events">
            <TabsList>
              <TabsTrigger value="events">Why it fired ({data.events.length})</TabsTrigger>
              <TabsTrigger value="actions">Decisions ({data.actions.length})</TabsTrigger>
              <TabsTrigger value="cross">
                Also watching ({data.crossReference?.cameras.length ?? 0})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="events" className="flex max-w-3xl flex-col gap-4 pt-4">
              {data.events.map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </TabsContent>

            <TabsContent value="actions" className="flex max-w-3xl flex-col gap-3 pt-4">
              {data.actions.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No decision recorded yet. This incident is still open.
                </p>
              )}
              {data.actions.map((action) => (
                <ActionRow key={action.id} action={action} />
              ))}
            </TabsContent>

            <TabsContent value="cross" className="flex max-w-3xl flex-col gap-4 pt-4">
              <CrossReferencePanel cross={data.crossReference} />
            </TabsContent>
          </Tabs>}
        </>
      )}
    </PageShell>
  );
}

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

/** #21 — the box, the path, the zone, the named rule, and the confidence. */
function EventCard({ event }: { event: IbvapEvent }) {
  const { evidence } = event;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={event.severity} />
        <span className="font-mono text-xs text-muted-foreground">seq {event.seq}</span>
        <span className="text-sm font-medium">
          {event.class ? humanise(event.class) : humanise(event.kind)}
          {event.direction && (
            <span className="text-muted-foreground"> · {event.direction}</span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {event.source.simulated && <SimulatedBadge />}
          {!event.alertable && event.suppressedReason && (
            <SuppressedBadge reason={event.suppressedReason} />
          )}
        </div>
      </div>

      <EvidenceMap event={event} className="aspect-video w-full" />
      <p className="text-xs text-muted-foreground">
        Track and crossing point projected onto the ground from the camera's bearing and
        range. No frame is stored — thumbnails and clips are cut from the node's rolling
        buffer on request.
      </p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        <Fact label="Rule" value={event.rule ?? "—"} mono />
        <Fact label="Zone" value={evidence.zone?.name ?? "—"} />
        <Fact label="Confidence" value={percent(event.confidence)} mono />
        <Fact label="Source" value={`${event.source.type} · ${event.source.id}`} mono />
        <Fact label="Occurred" value={clockTime(event.occurredAt)} mono />
        {/* The wait-and-confirm trade (#13), stated openly rather than hidden. */}
        {evidence.confirmSeconds !== undefined && (
          <Fact
            label="Held / required"
            value={`${evidence.heldSeconds ?? "?"}s / ${evidence.confirmSeconds}s`}
            mono
          />
        )}
      </dl>
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

function ActionRow({ action }: { action: Action }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono text-xs">
          {action.verb}
        </Badge>
        <span className="text-muted-foreground">
          {action.actor.name} · {action.actor.role}
        </span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {clockTime(action.at)}
        </span>
      </div>
      {action.reason && <p className="text-sm">“{action.reason}”</p>}
      <code className="truncate font-mono text-[10px] text-muted-foreground">
        {action.hash.slice(0, 32)}…
      </code>
    </div>
  );
}


/**
 * What else was watching this zone, and what it saw.
 *
 * A zone spans cameras, so the question after "what happened" is "what else
 * could have seen it". Cameras are listed whether or not they caught anything:
 * a second camera on the same fence seeing nothing is a real piece of
 * information, and hiding it would leave the operator to assume.
 */
function CrossReferencePanel({ cross }: { cross: CrossReference | undefined }) {
  if (!cross?.zone) {
    return (
      <p className="text-sm text-muted-foreground">
        This incident is not tied to a zone, so there is nothing to cross-reference against.
      </p>
    );
  }

  const others = cross.cameras.filter((camera) => !camera.isSource);
  const minutes = Math.round((cross.windowSeconds ?? 1800) / 60);

  return (
    <>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Cameras on {cross.zone.name}
        </h3>
        {others.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Only one camera watches this zone, so there is no second angle on it.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {cross.cameras.map((camera) => {
              const body = (
                <>
                  <CctvIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{camera.cameraName}</span>
                  {camera.isSource && (
                    <Badge variant="secondary" className="ml-1 font-normal">
                      this incident
                    </Badge>
                  )}
                  {!camera.enabled && (
                    <Badge variant="destructive" className="ml-1 font-normal">
                      out of service
                    </Badge>
                  )}
                  <Badge variant="outline" className="ml-auto font-mono text-[10px] font-normal">
                    {camera.cameraStatus}
                  </Badge>
                </>
              );

              const shell = "flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm";

              return (
                <li key={camera.cameraId}>
                  {camera.isSource ? (
                    // The feed this incident came from -- you are already here.
                    <div className={cn(shell, "opacity-70")}>{body}</div>
                  ) : (
                    // A real anchor: right-click to copy, middle-click to open
                    // alongside. That is the whole point of pages over drawers.
                    <Link to={`/cameras/${camera.cameraId}`} className={cn(shell, "transition-colors hover:bg-accent")}>
                      {body}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Around the same time ({cross.incidents.length})
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Other incidents on this zone within {minutes} minutes either side.
        </p>
        {cross.incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing else was raised on this zone in that window.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {cross.incidents.map((incident) => (
              <li
                key={incident.id}
                className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
              >
                <SeverityBadge severity={incident.severity} />
                <span className="min-w-0 flex-1 truncate">{incident.title}</span>
                {/* A dismissed neighbour is still related activity, but it has
                    been dealt with -- saying so stops it reading as live. */}
                <Badge
                  variant="outline"
                  className="shrink-0 font-mono text-[10px] font-normal text-muted-foreground"
                >
                  {incident.status}
                </Badge>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {clockTime(incident.lastEventAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
