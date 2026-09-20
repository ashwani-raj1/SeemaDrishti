import { useCallback } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useClient } from "@/client/context";
import { ProvisionalBadge } from "@/components/ibvap/badges";
import type { FeedZone } from "@/components/ibvap/camera-feed";
import { SEVERITY_RANK, type Severity } from "@/lib/types";
import { ServiceShell } from "./service-shell";

/**
 * The virtual fence, as one camera sees it.
 *
 * The zones drawn on the picture here are the SAME normalised 0..1 points the
 * detector judges against -- not a decorative approximation of them. That is
 * the whole reason the shape is drawn in image space rather than on a map: what
 * an operator sees on this frame is literally the geometry that fires.
 *
 * A crossing being HELD shows in the live console with an amber row and never
 * as an incident, because it is not one yet. It becomes an incident only after
 * it survives both halves of the confirm window, and then it arrives from the
 * node with a severity this page did not choose.
 */
export function FenceScreen() {
  const { cameras: known, media } = useClient();

  const zonesFor = useCallback(
    (cameraId: string): FeedZone[] => {
      const camera = known.find((entry) => entry.id === cameraId);
      return (camera?.zones ?? []).map((zone) => ({
        id: zone.id,
        name: zone.name,
        geometry: zone.geometry,
        points: zone.points,
        severity: zone.severity,
        provisional: zone.provisional,
      }));
    },
    [known],
  );

  return (
    <ServiceShell
      title="Virtual fence"
      description="Zone intrusion and line crossing, judged on the camera's own frame."
      module="fence"
      eventKinds={["zone_crossing"]}
      zonesFor={zonesFor}
    >
      {(camera) => {
        const zones =
          known.find((entry) => entry.id === camera.id)?.zones ?? [];
        return (
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-sm font-medium">
                Zones watched on this camera
              </CardTitle>
              <Button asChild size="sm" variant="outline">
                <Link to="/zones">Edit zones</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {zones.length === 0 ? (
                // Not an error, and worth saying precisely: a camera with no
                // zone is watched but judged against nothing, so it will never
                // produce an intrusion however much crosses it.
                <p className="text-sm text-muted-foreground">
                  No zone is bound to this camera, so nothing on it can be
                  judged as a crossing. Draw one on the Zones page.
                </p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {zones.map((zone) => (
                    <div key={zone.bindingId ?? zone.id} className="rounded-md border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium">{zone.name}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          {zone.provisional && <ProvisionalBadge />}
                          <Badge variant="outline" className="text-[10px] uppercase">
                            {zone.geometry}
                          </Badge>
                        </div>
                      </div>
                      {zone.provisional && (
                        // The fence operator's page is where somebody notices,
                        // so name the consequence and offer the cure in place.
                        <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                          Nobody has drawn this shape on this camera. Crossings
                          are recorded and never alerted.{" "}
                          <Link to="/zones" className="underline underline-offset-2">
                            Draw it
                          </Link>
                        </p>
                      )}
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <dt>Direction</dt>
                        <dd className="text-right font-mono">{zone.direction}</dd>
                        <dt>Confirm</dt>
                        <dd className="text-right font-mono">{zone.confirmSeconds}s</dd>
                        <dt>Alerts on</dt>
                        <dd className="text-right">
                          {zone.watchClasses.length ? zone.watchClasses.join(", ") : "—"}
                        </dd>
                        {zone.logOnlyClasses.length > 0 && (
                          <>
                            {/* Named out loud. "Logged, never alerted" is the
                                animal filter, and an operator who cannot see
                                which classes are suppressed has no way to
                                defend the suppression. */}
                            <dt>Logged only</dt>
                            <dd className="text-right">{zone.logOnlyClasses.join(", ")}</dd>
                          </>
                        )}
                      </dl>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      }}
    </ServiceShell>
  );
}

/** Worst severity among a zone's alerting targets. */
export const worstOf = (severities: Severity[]): Severity =>
  severities.reduce<Severity>(
    (worst, next) => (SEVERITY_RANK[next] > SEVERITY_RANK[worst] ? next : worst),
    "INFO",
  );
