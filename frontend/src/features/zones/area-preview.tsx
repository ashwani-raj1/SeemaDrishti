import { useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Polygon, Polyline, Tooltip, useMap } from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import { BasemapLayer } from "@/components/ibvap/basemap";
import { useClient } from "@/client/context";
import {
  ATTARI_SECTOR, fovPolygon, type GeoPoint, type SiteGeography,
} from "@/client/geography";
import { cn } from "@/lib/utils";

/**
 * The area, drawn, next to the list you are choosing from.
 *
 * Picking a sector by name and then guessing which ground it covers is how a
 * zone ends up watching the wrong stretch of fence. So the selection is shown:
 * the area shaded, every camera in the sector lit with the cone it actually
 * sees, and the ones you have not ticked left dim.
 */

const ll = (point: GeoPoint): LatLngExpression => [point.lat, point.lon];
const path = (points: GeoPoint[]): LatLngExpression[] => points.map(ll);

const SELECTED = "#16a34a";
const AVAILABLE = "#0ea5e9";
const OUTSIDE = "#94a3b8";

/** Keep the whole chosen area in view when it changes. */
function FitArea({ area }: { area: GeoPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (area.length === 0) return;
    const lats = area.map((p) => p.lat);
    const lons = area.map((p) => p.lon);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [24, 24] },
    );
  }, [map, area]);
  return null;
}

export function AreaPreview({
  area,
  inArea,
  selected,
  onToggle,
  geo = ATTARI_SECTOR,
  className,
}: {
  /** The sector polygon. Empty means nothing is chosen yet. */
  area: GeoPoint[];
  /** Camera ids standing inside the area. */
  inArea: string[];
  /** Camera ids ticked for the zone. */
  selected: string[];
  onToggle?: (cameraId: string) => void;
  geo?: SiteGeography;
  className?: string;
}) {
  const { cameras, config } = useClient();
  const basemap = config.basemaps[0];

  const centre: LatLngExpression = [
    (geo.bounds.north + geo.bounds.south) / 2,
    (geo.bounds.east + geo.bounds.west) / 2,
  ];

  const nameOf = useMemo(
    () => new Map(cameras.map((camera) => [camera.id, camera.name])),
    [cameras],
  );

  const placed = Object.entries(geo.cameras);

  return (
    <div className={cn("relative overflow-hidden rounded-md border bg-muted", className)}>
      <MapContainer center={centre} zoom={13} scrollWheelZoom className="size-full bg-muted">
        {area.length > 0 && <FitArea area={area} />}
        {basemap && <BasemapLayer basemap={basemap} />}

        {/* The international boundary and the fence, for orientation. */}
        <Polyline
          positions={path(geo.border)}
          pathOptions={{ color: "#dc2626", weight: 2, dashArray: "8 5", opacity: 0.8 }}
        />
        <Polyline
          positions={path(geo.fence)}
          pathOptions={{ color: "#f59e0b", weight: 2, opacity: 0.7 }}
        />

        {area.length > 0 && (
          <Polygon
            positions={path(area)}
            pathOptions={{
              color: SELECTED,
              weight: 2,
              dashArray: "6 4",
              fillColor: SELECTED,
              fillOpacity: 0.08,
            }}
          />
        )}

        {placed.map(([cameraId, placement]) => {
          const isInside = inArea.includes(cameraId);
          const isPicked = selected.includes(cameraId);
          const colour = !isInside ? OUTSIDE : isPicked ? SELECTED : AVAILABLE;

          return (
            <div key={cameraId}>
              {/* What the camera can actually see, not just where it stands. */}
              {isInside && (
                <Polygon
                  positions={path(fovPolygon(placement))}
                  pathOptions={{
                    color: colour,
                    weight: 1,
                    opacity: isPicked ? 0.7 : 0.35,
                    fillColor: colour,
                    fillOpacity: isPicked ? 0.16 : 0.06,
                  }}
                />
              )}
              <CircleMarker
                center={ll(placement.at)}
                radius={isPicked ? 8 : 6}
                pathOptions={{
                  color: colour,
                  weight: 2,
                  fillColor: colour,
                  fillOpacity: isInside ? (isPicked ? 1 : 0.5) : 0.2,
                  opacity: isInside ? 1 : 0.4,
                }}
                eventHandlers={
                  isInside && onToggle ? { click: () => onToggle(cameraId) } : undefined
                }
              >
                <Tooltip direction="top" offset={[0, -8]}>
                  <span className="font-medium">{nameOf.get(cameraId) ?? cameraId}</span>
                  <br />
                  {!isInside
                    ? "outside this area"
                    : isPicked
                      ? "in this zone — click to remove"
                      : "click to add to the zone"}
                </Tooltip>
              </CircleMarker>
            </div>
          );
        })}
      </MapContainer>

      <div className="pointer-events-none absolute bottom-2 left-2 z-[400] flex flex-wrap gap-2 rounded bg-background/85 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
        <Key colour={SELECTED} label="in this zone" />
        <Key colour={AVAILABLE} label="in the area" />
        <Key colour={OUTSIDE} label="elsewhere" />
      </div>
    </div>
  );
}

function Key({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="size-2 rounded-full" style={{ background: colour }} />
      {label}
    </span>
  );
}
