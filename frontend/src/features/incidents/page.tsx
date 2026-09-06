import { Link, useParams } from "react-router-dom";
import { CctvIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SeverityBadge, SimulatedBadge, SuppressedBadge } from "@/components/ibvap/badges";
import { EvidenceMap } from "@/components/ibvap/evidence-map";
import { ErrorState, LoadingRows } from "@/components/ibvap/states";
import { PageShell } from "@/components/ibvap/page-shell";
import { ShareLink } from "@/components/ibvap/share-link";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { clockTime, dateTime, humanise, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Action, CrossReference, IbvapEvent } from "@/lib/types";

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
          <Tabs defaultValue="events">
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
          </Tabs>
        </>
      )}
    </PageShell>
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
