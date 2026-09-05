/**
 * One camera's ground: where it sits, what it covers, and the zones drawn on
 * its picture -- projected onto imagery rather than floating on a grid.
 */
import { useMemo, useState } from "react";
import { CircleMarker, MapContainer, Polygon, Polyline, Popup } from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import { useClient } from "@/client/context";
import {
  formatLatLon, fovPolygon, framePathToGround, gridRef, placementOf, ATTARI_SECTOR,
  type GeoPoint,
} from "@/client/geography";
import type { Camera, Severity } from "@/lib/types";
import { humanise } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EvidenceOverlay } from "./evidence-overlay";
import { BasemapLayer, BasemapSwitcher, OfflineNotice, TileWatch } from "./basemap";
import { SeverityBadge } from "./badges";

const ll = (point: GeoPoint): LatLngExpression => [point.lat, point.lon];

const SEVERITY_COLOUR: Record<Severity, string> = {
  INFO: "#78716c",
  WARNING: "#f59e0b",
  CRITICAL: "#dc2626",
};

export function CameraMap({
  camera,
  className,
  showSwitcher = false,
}: {
  camera: Camera;
  className?: string;
  showSwitcher?: boolean;
}) {
  const { config } = useClient();
  const [basemapId, setBasemapId] = useState(config.basemaps[0]?.id ?? "none");
  const [tilesOk, setTilesOk] = useState(true);

  const placement = placementOf(camera.id);
  const basemap = config.basemaps.find((option) => option.id === basemapId) ?? config.basemaps[0];

  const zones = useMemo(
    () =>
      placement
        ? camera.zones.map((zone) => ({
            zone,
            ground: framePathToGround(zone.points, placement),
          }))
        : [],
    [camera.zones, placement],
  );

  // Nothing known about where this camera is: the schematic is honest, a map
  // with an invented position is not.
  if (!placement || !basemap) {
    return (
      <EvidenceOverlay
        evidence={{ zone: camera.zones[0] ? { ...camera.zones[0] } : undefined }}
        className={className}
      />
    );
  }

  const blind = camera.status === "DEAD" || camera.status === "RECORD_ONLY";

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
          positions={fovPolygon(placement).map(ll)}
          pathOptions={{
            color: blind ? "#dc2626" : "#0ea5e9",
            weight: 1,
            fillOpacity: blind ? 0.06 : 0.14,
            dashArray: blind ? "3 4" : undefined,
          }}
        />

        {zones.map(({ zone, ground }) => {
          const options = {
            color: SEVERITY_COLOUR[zone.severity],
            weight: 3,
            dashArray: "6 4",
            fillOpacity: 0.12,
          };
          const popup = (
            <Popup>
              <div className="flex min-w-44 flex-col gap-1 text-xs">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={zone.severity} />
                  <span className="font-mono text-muted-foreground">{humanise(zone.kind)}</span>
                </div>
                <span className="text-sm font-medium">{zone.name}</span>
                <span className="font-mono text-muted-foreground">
                  alert on {zone.watchClasses.join(", ") || "—"}
                </span>
                <span className="font-mono text-muted-foreground">
                  logged {zone.logOnlyClasses.join(", ") || "—"}
                </span>
              </div>
            </Popup>
          );

          return zone.geometry === "polygon" ? (
            <Polygon key={zone.id} positions={ground.map(ll)} pathOptions={options}>
              {popup}
            </Polygon>
          ) : (
            <Polyline key={zone.id} positions={ground.map(ll)} pathOptions={options}>
              {popup}
            </Polyline>
          );
        })}

        <CircleMarker
          center={ll(placement.at)}
          radius={6}
          pathOptions={{ color: "#ffffff", fillColor: "#0ea5e9", fillOpacity: 1, weight: 2 }}
        >
          <Popup>
            <div className="flex min-w-44 flex-col gap-1 text-xs">
              <span className="text-sm font-medium">{camera.name}</span>
              <span className="font-mono text-muted-foreground">
                {camera.status.replace(/_/g, " ")} · grid {gridRef(placement.at, ATTARI_SECTOR)}
              </span>
              <span className="font-mono text-muted-foreground">
                bearing {placement.bearing}° · {placement.fovDeg}° · {placement.rangeM} m
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {formatLatLon(placement.at)}
              </span>
            </div>
          </Popup>
        </CircleMarker>
      </MapContainer>

      {showSwitcher && (
        <BasemapSwitcher basemaps={config.basemaps} activeId={basemapId} onChange={setBasemapId} />
      )}
      <OfflineNotice show={basemap.kind !== "none" && !tilesOk} />
    </div>
  );
}
