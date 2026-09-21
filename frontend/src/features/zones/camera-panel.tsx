import { useEffect, useRef, useState } from "react";
import { CircleMarker, MapContainer, Polygon, Polyline, Tooltip, useMap } from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import { CctvIcon, MapIcon, VideoIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BasemapLayer } from "@/components/ibvap/basemap";
import { useClient } from "@/client/context";
import {
  ATTARI_SECTOR, formatLatLon, fovPolygon, gridRef, type GeoPoint,
} from "@/client/geography";
import { playWhep, whepUrl, type FeedState } from "@/lib/whep";
import { cn } from "@/lib/utils";

/**
 * Where the selected camera is, and what it can see, in one box.
 *
 * TWO VIEWS OF THE SAME QUESTION, and a supervisor needs both while choosing
 * cameras for a zone: "is this the right stretch of fence" is a map question,
 * "is this the right camera" is a picture question. They used to be different
 * screens, which meant picking cameras for a zone and checking what they were
 * pointed at could not happen at the same time.
 *
 * Toggled rather than shown side by side because both want the same space: a
 * map too small to read is not a map, and a feed too small to recognise a
 * person in is not evidence of anything.
 *
 * The map FOLLOWS the selection -- picking a camera in the list flies to it and
 * draws its field of view. A static sector view left the operator matching
 * names against dots.
 */

const ll = (point: GeoPoint): LatLngExpression => [point.lat, point.lon];
const path = (points: GeoPoint[]): LatLngExpression[] => points.map(ll);

const CHOSEN = "#16a34a";
const OTHER = "#94a3b8";

/**
 * Fly to the focused camera.
 *
 * `flyTo` rather than `setView`: the animation is what tells the eye that the
 * dot it is now looking at is the one that just moved into the middle. A jump
 * cut between two similar-looking fields is indistinguishable from nothing
 * having happened.
 */
function FollowCamera({ at, zoom }: { at: GeoPoint | null; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    if (!at) return;
    map.flyTo([at.lat, at.lon], zoom, { duration: 0.6 });
  }, [map, at?.lat, at?.lon, zoom]);
  return null;
}

export interface CameraPanelProps {
  /** Camera currently in hand, or null when nothing is selected. */
  cameraId: string | null;
  cameraName?: string;
  /** Everything selectable, so the unchosen ones still show as context. */
  cameraIds: string[];
  /** Which of those are in the zone being built. */
  chosen: string[];
  onPick?: (cameraId: string) => void;
  className?: string;
}

export function CameraPanel({
  cameraId, cameraName, cameraIds, chosen, onPick, className,
}: CameraPanelProps) {
  const { config } = useClient();
  const [view, setView] = useState<"map" | "feed">("map");
  // The first configured basemap, as every other map here does it. A
  // deployment with none configured still gets the vectors, just no imagery.
  const basemap = config.basemaps[0];
  const placement = cameraId ? ATTARI_SECTOR.cameras[cameraId] : undefined;

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            {cameraName ?? "No camera selected"}
          </span>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant={view === "map" ? "secondary" : "ghost"}
            onClick={() => setView("map")}
          >
            <MapIcon className="size-4" /> Map
          </Button>
          <Button
            size="sm"
            variant={view === "feed" ? "secondary" : "ghost"}
            onClick={() => setView("feed")}
            disabled={!cameraId}
          >
            <VideoIcon className="size-4" /> Feed
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
        {view === "map" ? (
          <MapContainer
            center={placement ? [placement.at.lat, placement.at.lon] : [31.61, 74.585]}
            zoom={placement ? 16 : 13}
            scrollWheelZoom
            className="size-full"
          >
            {basemap && <BasemapLayer basemap={basemap} />}
            <FollowCamera at={placement?.at ?? null} zoom={16} />

            <Polyline positions={path(ATTARI_SECTOR.border)} pathOptions={{ color: "#dc2626", weight: 2, dashArray: "6 4" }} />
            <Polyline positions={path(ATTARI_SECTOR.fence)} pathOptions={{ color: "#f59e0b", weight: 2 }} />

            {cameraIds.map((id) => {
              const spot = ATTARI_SECTOR.cameras[id];
              // A camera nobody has surveyed has no position, so it cannot be
              // drawn. Said in the list instead of guessed at here -- a dot at
              // [0,0] would put a patrol in the wrong field.
              if (!spot) return null;
              const isChosen = chosen.includes(id);
              const isFocused = id === cameraId;
              const colour = isChosen ? CHOSEN : OTHER;
              return (
                <div key={id}>
                  {isFocused && (
                    <Polygon
                      positions={path(fovPolygon(spot))}
                      pathOptions={{ color: colour, weight: 1, fillOpacity: 0.18 }}
                    />
                  )}
                  <CircleMarker
                    center={ll(spot.at)}
                    radius={isFocused ? 8 : 5}
                    pathOptions={{
                      color: colour,
                      weight: isFocused ? 3 : 1.5,
                      fillColor: colour,
                      fillOpacity: isChosen ? 0.9 : 0.35,
                    }}
                    eventHandlers={onPick ? { click: () => onPick(id) } : undefined}
                  >
                    <Tooltip>{id}</Tooltip>
                  </CircleMarker>
                </div>
              );
            })}
          </MapContainer>
        ) : (
          cameraId && <PanelFeed cameraId={cameraId} />
        )}
      </div>

      {placement ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Grid</dt>
          <dd className="text-right font-mono">{gridRef(placement.at, ATTARI_SECTOR)}</dd>
          <dt className="text-muted-foreground">Position</dt>
          <dd className="text-right font-mono">{formatLatLon(placement.at)}</dd>
          <dt className="text-muted-foreground">Bearing / range</dt>
          <dd className="text-right font-mono">
            {placement.bearing}° · {placement.rangeM} m
          </dd>
        </dl>
      ) : (
        cameraId && (
          <p className="text-xs text-muted-foreground">
            No surveyed position for this camera, so it has no grid reference and
            does not appear on the map. The zone still works — only the map
            placement is missing.
          </p>
        )
      )}
    </div>
  );
}

/** The camera's live picture, with no overlay: this is a "which camera" check. */
function PanelFeed({ cameraId }: { cameraId: string }) {
  const { media } = useClient();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [feed, setFeed] = useState<FeedState>("connecting");
  const [detail, setDetail] = useState<string>();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!media?.whepBase) {
      setFeed("down");
      setDetail("no media hub configured");
      return;
    }
    const handle = playWhep(video, whepUrl(media.whepBase, cameraId), (state, why) => {
      setFeed(state);
      setDetail(why);
    });
    return () => handle.close();
  }, [media?.whepBase, cameraId]);

  return (
    <div className="relative size-full bg-black">
      <video ref={videoRef} autoPlay muted playsInline className="size-full object-contain" />
      {feed !== "live" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <Badge variant={feed === "down" ? "destructive" : "secondary"}>
            {feed === "connecting" ? "connecting" : "no video"}
          </Badge>
          {detail && <p className="max-w-[36ch] text-xs text-white/70">{detail}</p>}
        </div>
      )}
    </div>
  );
}
