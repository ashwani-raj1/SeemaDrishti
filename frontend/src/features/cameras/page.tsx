import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CctvIcon, LayersIcon, SettingsIcon, SlashIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CameraStatusPill, SeverityBadge, SeverityDot } from "@/components/ibvap/badges";
import { CameraMap } from "@/components/ibvap/camera-map";
import { CameraFeed } from "@/components/ibvap/camera-feed";
import { useClient } from "@/client/context";
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

/**
 * What you are looking at.
 *
 * The picture answers "what is happening right now"; the ground answers "where
 * is that, and what else covers it". They are different questions and an
 * operator often wants both at once, so "both" is the default wherever there is
 * width for it. On a narrow screen the two stack, which is why this is a choice
 * rather than a fixed split.
 */
type View = "feed" | "ground" | "both";

export function CameraPage() {
  const { cameraId } = useParams();
  const navigate = useNavigate();
  const { media } = useClient();

  const [view, setView] = useState<View>("both");

  const { data, error, loading, reload } = useResource(
    () => (cameraId ? api.cameraIncidents(cameraId, { limit: 100 }) : Promise.resolve(null)),
    [cameraId],
  );

  const camera = data?.camera;

  // `media` is addresses, not a health check -- the node always sends them, so
  // this only falls back when talking to a build that does not. Whether the hub
  // is actually up is CameraFeed's own business, and it says so on the tile
  // rather than leaving a black rectangle.
  const showFeed = Boolean(media) && (view === "feed" || view === "both");
  const showGround = !media || view === "ground" || view === "both";
  const showBoth = showFeed && showGround;

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
            {media && (
              <div className="mr-1 flex rounded-md border p-0.5">
                {(["feed", "ground", "both"] as View[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setView(option)}
                    aria-pressed={view === option}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs capitalize transition-colors",
                      view === option
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
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

          {/* Full width, above the columns: side by side needs real room, and
              a 420px thumbnail of either is worth nothing at 3 a.m. */}
          <div className={cn("grid gap-4", showBoth && "xl:grid-cols-2")}>
            {showFeed && media && (
              <CameraFeed
                cameraId={camera.id}
                streamPath={camera.streamPath}
                whepBase={media.whepBase}
                zones={camera.zones}
                className="w-full"
              />
            )}
            {showGround && (
              <CameraMap
                camera={{
                  id: camera.id,
                  name: camera.name,
                  status: camera.status,
                  zones: camera.zones,
                }}
                className="aspect-video w-full"
              />
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            <div className="flex flex-col gap-5">
              <Section title="Watching" count={camera.zones.length}>
                {camera.zones.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing is drawn on this camera, so it raises nothing.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {camera.zones.map((zone) => (
                      <li key={zone.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                        <Link to={`/zones?zone=${zone.id}`} className="hover:underline">
                          {zone.name}
                        </Link>
                        {/* Kind and direction are facts about the zone, not
                            statuses -- two outline badges each gave them the
                            weight of an alert. */}
                        <span className="font-mono text-xs text-muted-foreground">
                          {humanise(zone.kind)} · {zone.direction}
                        </span>
                        {!zone.placed && (
                          <span className="text-xs text-amber-600 dark:text-amber-500">
                            shape not positioned
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {camera.siblings.length > 0 && (
                <Section
                  title="Also watching this ground"
                  hint="These cameras share a zone with this one, so they may have seen the same thing from a different angle."
                >
                  <ul className="flex flex-col gap-1.5">
                    {camera.siblings.map((sibling) => (
                      <li key={`${sibling.zoneId}:${sibling.cameraId}`}>
                        {/* A plain link. Bordered buttons here read as loudly
                            as the incident rows opposite, and following a
                            camera is not a decision. */}
                        <Link
                          to={`/cameras/${sibling.cameraId}`}
                          className="group flex items-baseline gap-2 rounded-sm py-0.5 text-sm hover:underline"
                        >
                          <CctvIcon className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
                          <span className="truncate">{sibling.cameraName}</span>
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                            via {sibling.zoneName}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-5">
              <Section title="Incidents" count={data.incidents.length} primary>
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

              <Section
                title="Recent activity"
                hint="Everything this feed recorded, including what was deliberately not raised."
              >
                {data.recentEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {data.recentEvents.slice(0, 20).map((event) => (
                      <li
                        key={event.id}
                        className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground"
                      >
                        <SeverityDot severity={event.severity} />
                        <span className="font-mono tabular-nums">
                          {clockTime(event.occurredAt)}
                        </span>
                        <span className="truncate text-foreground">
                          {event.class ? humanise(event.class) : humanise(event.kind)}
                          {event.direction ? ` ${event.direction}` : ""}
                        </span>
                        {/* Only the unusual case is worth a word. An alerted
                            event is the default here and needs no label -- the
                            incident above it is the label. */}
                        {!event.alertable && (
                          <span className="ml-auto shrink-0 font-mono">logged only</span>
                        )}
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

/**
 * Two weights, because these sections are not equal.
 *
 * `primary` is work an operator acts on. Everything else is context that
 * explains it. Rendering all four at the same weight -- which is what this page
 * did -- means the eye has nowhere to land and the operator reads top-to-bottom
 * like a document instead of jumping to what matters.
 */
function Section({
  title,
  count,
  primary,
  hint,
  children,
}: {
  title: string;
  count?: number;
  primary?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className={cn("flex items-baseline gap-2", hint ? "mb-1" : "mb-2")}>
        <h3
          className={cn(
            primary
              ? "text-sm font-semibold text-foreground"
              : "text-xs font-medium uppercase tracking-wide text-muted-foreground",
          )}
        >
          {title}
        </h3>
        {count !== undefined && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
        )}
      </div>
      {hint && <p className="mb-2 text-xs text-muted-foreground">{hint}</p>}
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
