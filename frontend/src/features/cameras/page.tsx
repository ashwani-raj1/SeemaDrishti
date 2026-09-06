import { Link, useNavigate, useParams } from "react-router-dom";
import { CctvIcon, LayersIcon, SettingsIcon, SlashIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CameraStatusPill, SeverityBadge } from "@/components/ibvap/badges";
import { CameraMap } from "@/components/ibvap/camera-map";
import { ErrorState, LoadingRows } from "@/components/ibvap/states";
import { PageShell } from "@/components/ibvap/page-shell";
import { ShareLink } from "@/components/ibvap/share-link";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { clockTime, dateTime, humanise } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Incident } from "@/lib/types";

/**
 * One feed, at its own address.
 *
 * Clicking a camera asks a different question from the incident queue. The
 * queue ranks across the whole post for triage; this is "what has this feed
 * seen", which is what you want when a particular stretch of ground is on your
 * mind. Same records, different question.
 *
 * It also answers what follows immediately: what else watches this ground.
 * Now that a zone spans cameras that is a lookup, not something the operator
 * has to hold in their head.
 */
export function CameraPage() {
  const { cameraId } = useParams();
  const navigate = useNavigate();

  const { data, error, loading, reload } = useResource(
    () => (cameraId ? api.cameraIncidents(cameraId, { limit: 100 }) : Promise.resolve(null)),
    [cameraId],
  );

  const camera = data?.camera;

  return (
    <PageShell
      title={camera?.name ?? "Camera"}
      description={
        camera
          ? `${camera.incidents.total} incident${camera.incidents.total === 1 ? "" : "s"} on this feed · ${camera.incidents.open} still open`
          : "Loading this feed's record…"
      }
      breadcrumbs={[{ label: "Cameras", to: "/cameras" }]}
      actions={
        <>
          <ShareLink />
          {camera && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/cameras?camera=${camera.id}`}>
                <SettingsIcon className="size-4" />
                Settings
              </Link>
            </Button>
          )}
        </>
      }
      toolbar={
        camera && (
          <div className="flex flex-wrap items-center gap-2">
            <CameraStatusPill status={camera.status} />
            {!camera.enabled && (
              <Badge variant="destructive" className="gap-1">
                <SlashIcon className="size-3" />
                out of service
              </Badge>
            )}
            <Badge variant="secondary" className="font-mono text-xs">
              {camera.id}
            </Badge>
          </div>
        )
      }
    >
      {loading && !data && <LoadingRows rows={4} />}
      {error && <ErrorState error={error} onRetry={reload} />}

      {data && camera && (
        <>
          <Separator />

          {!camera.enabled && (
            <p className="max-w-3xl rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
              This feed is out of service. Detections still arrive, but nothing crossing it is being
              judged and no incidents are raised.
            </p>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            <div className="flex flex-col gap-5">
              <CameraMap
                camera={{
                  id: camera.id,
                  name: camera.name,
                  status: camera.status,
                  zones: camera.zones,
                }}
                className="aspect-video w-full"
              />

              <Section title="Zones on this feed">
                {camera.zones.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing is drawn on this camera, so it raises nothing.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {camera.zones.map((zone) => (
                      <li key={zone.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <Link to={`/zones?zone=${zone.id}`} className="font-medium hover:underline">
                          {zone.name}
                        </Link>
                        <Badge variant="outline" className="font-mono text-[10px] font-normal">
                          {humanise(zone.kind)}
                        </Badge>
                        <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                          {zone.direction}
                        </Badge>
                        {!zone.placed && (
                          <span className="text-[11px] text-amber-600 dark:text-amber-500">
                            shape not positioned
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {camera.siblings.length > 0 && (
                <Section title="Also watching this ground">
                  <p className="mb-2 text-xs text-muted-foreground">
                    These cameras share a zone with this one, so they may have seen the same thing
                    from a different angle.
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {camera.siblings.map((sibling) => (
                      <li key={`${sibling.zoneId}:${sibling.cameraId}`}>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-auto w-full justify-start gap-2 py-1.5 text-left font-normal"
                          asChild
                        >
                          <Link to={`/cameras/${sibling.cameraId}`}>
                            <CctvIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">{sibling.cameraName}</span>
                            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                              via {sibling.zoneName}
                            </span>
                          </Link>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-5">
              <Section title={`Incidents on this feed (${data.incidents.length})`}>
                {data.incidents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing has been raised on this camera.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {data.incidents.map((incident) => (
                      <IncidentRow
                        key={incident.id}
                        incident={incident}
                        onOpen={() => navigate(`/incidents/${incident.id}`)}
                      />
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Recent activity">
                {data.recentEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {data.recentEvents.slice(0, 20).map((event) => (
                      <li key={event.id} className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-muted-foreground">
                          {clockTime(event.occurredAt)}
                        </span>
                        <span className="truncate">
                          {event.class ? humanise(event.class) : humanise(event.kind)}
                          {event.direction ? ` ${event.direction}` : ""}
                        </span>
                        <span className="ml-auto shrink-0">
                          {event.alertable ? (
                            <SeverityBadge severity={event.severity} />
                          ) : (
                            <Badge variant="secondary" className="font-mono text-[10px]">
                              logged
                            </Badge>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function IncidentRow({
  incident,
  onOpen,
  className,
}: {
  incident: Incident;
  onOpen: () => void;
  className?: string;
}) {
  return (
    <li className={className}>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-wrap items-center gap-2 rounded-md border p-2 text-left transition-colors hover:bg-accent"
      >
        <SeverityBadge severity={incident.severity} />
        <span className="min-w-0 flex-1 truncate text-sm">{incident.title}</span>
        <Badge
          variant="outline"
          className={cn(
            "font-mono text-[10px] font-normal",
            incident.status === "DISMISSED" && "text-muted-foreground",
          )}
        >
          {incident.status}
        </Badge>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {dateTime(incident.lastEventAt)}
        </span>
      </button>
    </li>
  );
}
