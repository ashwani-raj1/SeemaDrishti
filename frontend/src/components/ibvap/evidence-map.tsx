/**
 * "Why it fired" — on the ground it happened on (#21).
 *
 * The same evidence as the schematic overlay, but projected onto imagery: the
 * zone, the path walked, and where the line was crossed. On a blank grid those
 * marks are abstract; on the ground they answer "which field, and heading
 * where", which is the operator's actual next question.
 *
 * Falls back to the schematic whenever this deployment does not know where the
 * camera is — the geometry is still true in frame space, and inventing a
 * position to make a map look complete would be worse than showing neither.
 */
import { useMemo, useState } from "react";
import { CircleMarker, MapContainer, Polygon, Polyline, Popup } from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import { useClient } from "@/client/context";
import {
  ATTARI_SECTOR, formatLatLon, fovPolygon, framePathToGround, frameToGround,
  gridRef, placementOf, type GeoPoint,
} from "@/client/geography";
import type { Evidence, IbvapEvent } from "@/lib/types";
import { clockTime, humanise, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EvidenceOverlay } from "./evidence-overlay";
import { BasemapLayer, BasemapSwitcher, OfflineNotice, TileWatch } from "./basemap";

const ll = (point: GeoPoint): LatLngExpression => [point.lat, point.lon];

export function EvidenceMap({
  event,
  className,
}: {
  event: IbvapEvent;
  className?: string;
}) {
  const { config, cameras } = useClient();
  const [basemapId, setBasemapId] = useState(config.basemaps[0]?.id ?? "none");
  const [tilesOk, setTilesOk] = useState(true);

  const placement = placementOf(event.cameraId);
  const basemap = config.basemaps.find((option) => option.id === basemapId) ?? config.basemaps[0];
  const camera = cameras.find((item) => item.id === event.cameraId);

  const ground = useMemo(() => {
    if (!placement) return null;
    const evidence: Evidence = event.evidence;
    return {
      zone: evidence.zone ? framePathToGround(evidence.zone.points, placement) : null,
      path: evidence.path ? framePathToGround(evidence.path, placement) : null,
      crossedAt: evidence.crossedAt ? frameToGround(evidence.crossedAt, placement) : null,
      fov: fovPolygon(placement),
    };
  }, [event.evidence, placement]);

  // No placement for this camera: the schematic is the honest answer.
  if (!placement || !ground || !basemap) {
    return <EvidenceOverlay evidence={event.evidence} className={className} />;
  }

  const geometry = event.evidence.zone;

  return (
    <div className={cn("relative overflow-hidden rounded-md border", className)}>
      <MapContainer
        center={ll(placement.at)}
        zoom={17}
        scrollWheelZoom={false}
        className="size-full bg-muted"
      >
        <BasemapLayer basemap={basemap} />
        <TileWatch onState={setTilesOk} />

        <Polygon
          positions={ground.fov.map(ll)}
          pathOptions={{ color: "#0ea5e9", weight: 1, fillOpacity: 0.1 }}
        />

        {ground.zone && geometry?.geometry === "polygon" && (
          <Polygon
            positions={ground.zone.map(ll)}
            pathOptions={{ color: "#f59e0b", weight: 2, fillOpacity: 0.12, dashArray: "5 4" }}
          >
            <Popup>
              <ZonePopup name={geometry.name} kind={geometry.kind} />
            </Popup>
          </Polygon>
        )}

        {ground.zone && geometry?.geometry === "line" && (
          <Polyline
            positions={ground.zone.map(ll)}
            pathOptions={{ color: "#f59e0b", weight: 3, dashArray: "6 4" }}
          >
            <Popup>
              <ZonePopup name={geometry.name} kind={geometry.kind} />
            </Popup>
          </Polyline>
        )}

        {/* Which way they walked. */}
        {ground.path && ground.path.length >= 2 && (
          <Polyline
            positions={ground.path.map(ll)}
            pathOptions={{ color: "#ffffff", weight: 3, opacity: 0.9 }}
          />
        )}
        {ground.path && ground.path.length >= 2 && (
          <Polyline
            positions={ground.path.map(ll)}
            pathOptions={{ color: "#111827", weight: 1.5, dashArray: "3 3" }}
          />
        )}

        <CircleMarker
          center={ll(placement.at)}
          radius={5}
          pathOptions={{ color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 1, weight: 2 }}
        >
          <Popup>
            <div className="flex flex-col gap-1 text-xs">
              <span className="text-sm font-medium">{camera?.name ?? event.cameraId}</span>
              <span className="text-muted-foreground">{formatLatLon(placement.at)}</span>
              <span className="font-mono">
                bearing {placement.bearing}° · {placement.fovDeg}° FOV · {placement.rangeM} m
              </span>
              {camera && <span className="font-mono">state {camera.status}</span>}
            </div>
          </Popup>
        </CircleMarker>

        {ground.crossedAt && (
          <CircleMarker
            center={ll(ground.crossedAt)}
            radius={8}
            pathOptions={{ color: "#ffffff", fillColor: "#dc2626", fillOpacity: 0.9, weight: 2 }}
          >
            <Popup>
              <div className="flex flex-col gap-1 text-xs">
                <span className="text-sm font-medium">
                  {event.class ? humanise(event.class) : humanise(event.kind)}
                  {event.direction ? ` · ${event.direction}` : ""}
                </span>
                <span className="font-mono text-muted-foreground">
                  grid {gridRef(ground.crossedAt, ATTARI_SECTOR)} ·{" "}
                  {formatLatLon(ground.crossedAt)}
                </span>
                <span className="font-mono">rule {event.rule ?? "—"}</span>
                <span className="font-mono">
                  confidence {percent(event.confidence)} · {clockTime(event.occurredAt)}
                </span>
                {event.evidence.confirmSeconds !== undefined && (
                  <span className="font-mono">
                    held {event.evidence.heldSeconds ?? "?"}s of {event.evidence.confirmSeconds}s
                  </span>
                )}
                {!event.alertable && event.suppressedReason && (
                  <span className="text-muted-foreground">
                    Logged, never alerted — {humanise(event.suppressedReason)}
                  </span>
                )}
              </div>
            </Popup>
          </CircleMarker>
        )}
      </MapContainer>

      <BasemapSwitcher basemaps={config.basemaps} activeId={basemapId} onChange={setBasemapId} />
      <OfflineNotice show={basemap.kind !== "none" && !tilesOk} />

      <div className="pointer-events-none absolute bottom-2 left-2 z-[500] rounded bg-background/85 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        approximate ground projection · not a survey fix
      </div>
    </div>
  );
}

function ZonePopup({ name, kind }: { name: string; kind: string }) {
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <span className="text-sm font-medium">{name}</span>
      <span className="font-mono text-muted-foreground">{humanise(kind)}</span>
    </div>
  );
}
