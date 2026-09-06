import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageShell } from "@/components/ibvap/page-shell";
import { CameraStatusPill, SeverityBadge, SimulatedBadge } from "@/components/ibvap/badges";
import { CameraMap } from "@/components/ibvap/camera-map";
import { EvidenceMap } from "@/components/ibvap/evidence-map";
import { useClient } from "@/client/context";
import { onStream } from "@/lib/stream";
import { clockTime, humanise } from "@/lib/format";
import type { IbvapEvent } from "@/lib/types";
import { Link } from "react-router-dom";

const PER_CAMERA = 4;

/**
 * The camera grid — deliberately the secondary screen (#18).
 *
 * Every competing team builds this first. A three-person room cannot watch a
 * wall of tiles, so incidents lead and this follows. It is still worth having:
 * it answers "what is happening on that feed right now", which the incident
 * list is not shaped to answer.
 */
export function LiveCamerasScreen() {
  const { cameras } = useClient();
  const [recent, setRecent] = useState<Record<string, IbvapEvent[]>>({});

  useEffect(
    () =>
      onStream("event", (data) => {
        const event = data as IbvapEvent;
        if (!event.cameraId) return;
        setRecent((current) => ({
          ...current,
          [event.cameraId!]: [event, ...(current[event.cameraId!] ?? [])].slice(0, PER_CAMERA),
        }));
      }),
    [],
  );

  return (
    <PageShell
      title="Live cameras"
      description="Secondary by design. The incident queue is where work happens; this is for looking at one feed on purpose. Open a camera for its full record."
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cameras.map((camera) => {
          const events = recent[camera.id] ?? [];
          const latest = events[0];

          return (
            <Card key={camera.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  {/* A link, not a handler: it can be middle-clicked, copied
                      and sent. The tile only knows the minutes since this
                      screen opened; the page knows the whole record. */}
                  <Link
                    to={`/cameras/${camera.id}`}
                    className="truncate rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {camera.name}
                  </Link>
                  <CameraStatusPill status={camera.status} className="ml-auto" />
                </CardTitle>
                <CardDescription className="font-mono text-xs">
                  {camera.zones.map((zone) => zone.name).join(" · ") || "no zones"}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {/* The newest track if there is one, else the ground at rest. */}
                {latest ? (
                  <EvidenceMap event={latest} className="aspect-video w-full" />
                ) : (
                  <CameraMap camera={camera} className="aspect-video w-full" />
                )}

                <div className="flex flex-col gap-1.5">
                  {events.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Nothing since this screen opened.
                    </p>
                  )}
                  {events.map((event) => (
                    <div key={event.id} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-muted-foreground">
                        {clockTime(event.occurredAt)}
                      </span>
                      <span className="truncate">
                        {event.class ? humanise(event.class) : humanise(event.kind)}
                      </span>
                      <div className="ml-auto flex items-center gap-1">
                        {event.source.simulated && <SimulatedBadge />}
                        {!event.alertable ? (
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            logged
                          </Badge>
                        ) : (
                          <SeverityBadge severity={event.severity} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </PageShell>
  );
}
