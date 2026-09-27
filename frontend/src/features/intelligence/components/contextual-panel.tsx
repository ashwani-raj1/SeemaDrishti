/**
 * The evidence panel, shared by both intelligence modes.
 *
 * It renders an `IntelligenceResult` and nothing else. It has no idea whether
 * the AI chat or Manual Search produced it, and it must not grow a branch that
 * asks -- that shared contract is the only reason the two modes look coherent
 * side by side.
 *
 * Every coordinate on this panel comes from client/geography.ts, never from the
 * model and never from the node. Placement is deployment configuration the
 * browser holds; a language model that guessed a grid reference would be
 * worse than no grid reference at all.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CircleMarker, MapContainer, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import {
  CameraIcon,
  MapPinIcon,
  SparklesIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useClient, useZones } from "@/client/context";
import { ATTARI_SECTOR, formatLatLon, gridRef, placementOf } from "@/client/geography";
import { clockTime, dateTime, humanise } from "@/lib/format";
import { BasemapLayer } from "@/components/ibvap/basemap";
import { CameraFeed } from "@/components/ibvap/camera-feed";
import { SnapshotModal } from "./snapshot-modal";
import { ResultList } from "./result-list";
import { isImageUrl, type IntelligenceResult, type ResultItem } from "../result-model";

interface ContextualPanelProps {
  result: IntelligenceResult | null;
  onSelectPrompt?: (prompt: string) => void;
}

const DEFAULT_CENTER: [number, number] = [
  ATTARI_SECTOR.bounds.north - 0.04,
  ATTARI_SECTOR.bounds.west + 0.03,
];

/** What to ask the assistant about a row, given what the row is. */
function followUpFor(item: ResultItem): string {
  if (item.status) return `Explain incident ${item.id}`;
  if (item.plate) return `Find vehicle ${item.plate}`;
  if (item.cameraName) return `Show details for ${item.cameraName}`;
  return `What happened at ${item.zoneName ?? "this location"}?`;
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-[linear-gradient(180deg,#fff_0%,#f8fbff_100%)] p-6 text-center text-slate-500">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50">
        <SparklesIcon className="h-6 w-6 text-blue-500" />
      </div>
      <div className="text-sm font-semibold text-slate-800">Evidence</div>
      <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">
        Ask a question or run a manual search. The map, timeline and recorded
        images behind the answer appear here.
      </p>
    </div>
  );
}

/**
 * Plots whatever a set of result rows points at.
 *
 * Rows carry a camera id, not a position, so each marker is resolved through
 * the deployment's geography. Rows whose camera has no surveyed placement are
 * simply not drawn -- a marker at a made-up position would be a lie on a map
 * an operator is expected to act on.
 */
function EvidenceMap({ items, basemap }: { items: ResultItem[]; basemap: any }) {
  const placed = items
    .map((item) => ({ item, placement: item.cameraId ? placementOf(item.cameraId) : null }))
    .filter((entry) => entry.placement);

  const center: [number, number] = placed[0]
    ? [placed[0].placement!.at.lat, placed[0].placement!.at.lon]
    : DEFAULT_CENTER;

  return (
    <div className="relative z-0 h-44 w-full overflow-hidden rounded-xl border border-blue-100">
      <MapContainer
        center={center}
        zoom={14}
        style={{ height: "100%", width: "100%", background: "#eaf2ff" }}
        attributionControl={false}
        zoomControl={false}
      >
        <BasemapLayer basemap={basemap} />
        {placed.map(({ item, placement }) => (
          <CircleMarker
            key={item.id}
            center={[placement!.at.lat, placement!.at.lon]}
            radius={7}
            pathOptions={{
              color: item.severity === "CRITICAL" ? "#dc2626" : "#2563eb",
              fillColor: item.severity === "CRITICAL" ? "#ef4444" : "#3b82f6",
              fillOpacity: 0.9,
              weight: 2,
            }}
          >
            <Popup>
              <div className="font-sans text-xs">
                <div className="font-semibold">{item.title}</div>
                <div>{item.cameraName ?? "Unknown camera"}</div>
                <div>{dateTime(item.occurredAt)}</div>
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
      {placed.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-50/80 text-xs text-slate-500">
          No surveyed positions for these records.
        </div>
      )}
    </div>
  );
}

export function ContextualPanel({ result, onSelectPrompt }: ContextualPanelProps) {
  const { config, cameras, media } = useClient();
  const zones = useZones();
  const navigate = useNavigate();
  const [selectedSnapshot, setSelectedSnapshot] = useState<{
    url: string | null;
    label: string;
    metadata?: any;
  } | null>(null);

  const basemap = config.basemaps[0] ?? {
    id: "none",
    label: "Offline",
    kind: "none",
    url: "",
    attribution: "",
    maxZoom: 19,
  };

  if (!result || (result.kind === "none" && !result.multiple)) return <EmptyState />;

  const { vehicle, camera, zone, incident, multiple } = result;

  // Records carry ids; operators read names. Unresolved ids come back null so
  // the caller can fall back rather than printing the id itself.
  const nameOfCamera = (id: string | null | undefined) =>
    id ? cameras.find((c) => c.id === id)?.name ?? null : null;
  const nameOfZone = (id: string | null | undefined) =>
    id ? zones.find((z) => z.id === id)?.name ?? null : null;

  // ------------------------------------------------------------------
  // 1. Vehicle
  // ------------------------------------------------------------------
  if (result.kind === "vehicle" && vehicle) {
    const coords = vehicle.lastSeen?.coordinates;

    return (
      <div className="h-full overflow-y-auto bg-[linear-gradient(180deg,#fff_0%,#f8fbff_100%)] text-slate-700">
        <div className="space-y-3 border-b border-blue-100 p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                <MapPinIcon className="h-4 w-4 text-blue-600" /> Last seen location
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {vehicle.lastSeen
                  ? `${vehicle.lastSeen.cameraName} · ${dateTime(vehicle.lastSeen.occurredAt)}`
                  : "No recorded location"}
              </div>
            </div>
            <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 font-mono text-xs font-bold tracking-wide text-blue-700">
              {vehicle.formattedPlate}
            </span>
          </div>

          <div className="overflow-hidden rounded-xl border border-blue-100 bg-slate-950 shadow-sm">
            {isImageUrl(vehicle.lastSeen?.snapshot) ? (
              <img
                src={vehicle.lastSeen.snapshot}
                alt={`Evidence for ${vehicle.formattedPlate}`}
                className="h-44 w-full cursor-pointer object-cover"
                onClick={() =>
                  setSelectedSnapshot({
                    url: vehicle.lastSeen?.snapshot ?? null,
                    label: `Last seen: ${vehicle.lastSeen?.cameraName ?? "camera"}`,
                  })
                }
              />
            ) : vehicle.lastSeen?.cameraId && media?.whepBase ? (
              <CameraFeed
                cameraId={vehicle.lastSeen.cameraId}
                whepBase={media.whepBase}
                showBoxes={false}
                className="h-44"
              />
            ) : (
              <div className="flex h-44 flex-col items-center justify-center bg-blue-50 text-xs text-slate-500">
                <CameraIcon className="mb-2 h-6 w-6 text-blue-400" />
                Historical evidence is unavailable for this detection.
              </div>
            )}
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-slate-500">Coordinates</dt>
            <dd className="font-medium text-slate-700">{coords ? formatLatLon(coords) : "Not surveyed"}</dd>
            <dt className="text-slate-500">Grid</dt>
            <dd className="font-mono font-medium text-slate-700">{vehicle.lastSeen?.gridReference ?? "—"}</dd>
            <dt className="text-slate-500">Location</dt>
            <dd className="font-medium text-slate-700">
              {vehicle.lastSeen?.zoneName ?? vehicle.lastSeen?.cameraName ?? "Unknown"}
            </dd>
            <dt className="text-slate-500">Camera</dt>
            <dd className="font-medium text-slate-700">{vehicle.lastSeen?.cameraName ?? "—"}</dd>
          </dl>
        </div>

        <div className="border-b border-blue-100 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900">Detection timeline</span>
            <span className="text-xs text-blue-600">{vehicle.timeline.length} records</span>
          </div>
          {vehicle.timeline.length ? (
            <div className="relative ml-1 space-y-3 border-l-2 border-blue-200 pl-4">
              {vehicle.timeline.slice(0, 6).map((item, index) => (
                <div key={item.detectionId || index} className="relative text-xs">
                  <span
                    className={`absolute -left-[21px] top-0.5 h-3 w-3 rounded-full border-2 border-white ${
                      index === 0 ? "bg-red-500" : "bg-blue-500"
                    }`}
                  />
                  <div className="flex justify-between gap-2">
                    <span className="font-semibold text-slate-700">{clockTime(item.occurredAt)}</span>
                    <span className="font-medium text-slate-700">{item.cameraName}</span>
                  </div>
                  <div className="text-slate-500">{item.zoneName ?? "General surveillance area"}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              No recorded detections for this vehicle yet.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 p-4 text-xs">
          <div className="rounded-lg bg-blue-50 p-2.5">
            <div className="text-slate-500">Total detections</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{vehicle.totalSightings}</div>
          </div>
          <div className="rounded-lg bg-blue-50 p-2.5">
            <div className="text-slate-500">Watchlist status</div>
            <div
              className={`mt-1 font-semibold ${
                vehicle.watchlistStatus.isMatch ? "text-red-600" : "text-emerald-600"
              }`}
            >
              {vehicle.watchlistStatus.isMatch ? "Flagged" : "Clear"}
            </div>
          </div>
        </div>

        <SnapshotModal
          open={Boolean(selectedSnapshot)}
          onOpenChange={(open) => !open && setSelectedSnapshot(null)}
          snapshot={selectedSnapshot?.url ?? null}
          label={selectedSnapshot?.label}
          metadata={selectedSnapshot?.metadata}
        />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // 2. Camera
  // ------------------------------------------------------------------
  if (result.kind === "camera" && camera) {
    const coords = camera.coordinates;
    const center: [number, number] = coords ? [coords.lat, coords.lon] : DEFAULT_CENTER;

    return (
      <div className="h-full overflow-y-auto bg-[linear-gradient(180deg,#fff_0%,#f8fbff_100%)] text-slate-700">
        <div className="border-b border-blue-100 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-slate-900">{camera.cameraName}</h3>
            <Badge
              variant="outline"
              className={
                camera.status === "FULL"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-amber-200 bg-amber-50 text-amber-700"
              }
            >
              {camera.status}
            </Badge>
          </div>
        </div>

        {coords && (
          <div className="space-y-2 border-b border-blue-100 p-4">
            <div className="flex items-center justify-between text-xs font-medium">
              <span className="flex items-center gap-1.5 text-slate-700">
                <MapPinIcon className="h-3.5 w-3.5 text-emerald-500" />
                Coverage &amp; placement
              </span>
              <span className="rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 font-mono text-[11px] text-blue-700">
                GRID {camera.gridReference}
              </span>
            </div>
            <div className="relative z-0 h-44 w-full overflow-hidden rounded-md border border-blue-100">
              <MapContainer
                center={center}
                zoom={14}
                style={{ height: "100%", width: "100%", background: "#eaf2ff" }}
                attributionControl={false}
                zoomControl={false}
              >
                <BasemapLayer basemap={basemap} />
                <CircleMarker
                  center={center}
                  radius={7}
                  pathOptions={{ color: "#059669", fillColor: "#10b981", fillOpacity: 0.9, weight: 2 }}
                >
                  <Popup>
                    <div className="font-sans text-xs font-bold text-slate-900">{camera.cameraName}</div>
                  </Popup>
                </CircleMarker>
              </MapContainer>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] text-slate-500">
              <div>Bearing: {camera.bearing}°</div>
              <div>FOV: {camera.fovDeg}°</div>
              <div>Range: {camera.rangeM}m</div>
            </div>
          </div>
        )}

        <div className="flex-1 space-y-2 p-4">
          <div className="text-xs font-medium text-slate-700">
            Recent feed events ({camera.recentEvents.length})
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {camera.recentEvents.slice(0, 10).map((ev) => (
              <div key={ev.id} className="rounded border border-blue-100 bg-white p-2.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold capitalize text-slate-800">{ev.class ?? "activity"}</span>
                  <Badge variant="outline" className="h-4 text-[10px]">
                    {ev.severity}
                  </Badge>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {clockTime(ev.occurredAt)} · {ev.direction ?? "observed"}
                </div>
              </div>
            ))}
            {camera.recentEvents.length === 0 && (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">No recent events.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // 3. Incident
  // ------------------------------------------------------------------
  if (result.kind === "incident" && incident) {
    const inc = incident.incident;
    const evidenceSnapshot =
      (incident.events[0]?.evidence as { image_snapshot?: string | null } | undefined)?.image_snapshot ?? null;

    return (
      <div className="h-full overflow-y-auto bg-[linear-gradient(180deg,#fff_0%,#f8fbff_100%)] text-slate-700">
        <section className="border-b border-blue-100 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900">Event evidence</span>
            <button
              type="button"
              onClick={() => navigate("/map")}
              className="text-xs font-medium text-blue-600 hover:underline"
            >
              View in sector map ↗
            </button>
          </div>
          <div className="overflow-hidden rounded-xl border border-blue-100 bg-slate-950 shadow-sm">
            {isImageUrl(evidenceSnapshot) ? (
              <img
                src={evidenceSnapshot}
                alt="Incident evidence"
                className="h-44 w-full cursor-pointer object-cover"
                onClick={() => setSelectedSnapshot({ url: evidenceSnapshot, label: inc.title })}
              />
            ) : inc.cameraId && media?.whepBase ? (
              <CameraFeed cameraId={inc.cameraId} whepBase={media.whepBase} showBoxes={false} className="h-44" />
            ) : (
              <div className="flex h-44 flex-col items-center justify-center bg-blue-50 text-xs text-slate-500">
                <CameraIcon className="mb-2 h-6 w-6 text-blue-400" />
                No recorded image is available for this incident.
              </div>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center text-[11px]">
            <div>
              <div className="text-slate-400">BOP</div>
              <div className="font-semibold text-slate-700">
                {nameOfCamera(inc.cameraId) ?? incident.cameraName ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-slate-400">Zone</div>
              <div className="font-semibold text-slate-700">{nameOfZone(inc.zoneId) ?? "—"}</div>
            </div>
          </div>
        </section>

        {incident.actions.length > 0 && (
          <section className="border-b border-blue-100 p-3">
            <div className="mb-2 text-sm font-semibold text-slate-900">Operator actions</div>
            <div className="space-y-1.5">
              {incident.actions.map((action, index) => (
                <div key={index} className="rounded border border-blue-100 bg-white p-2 text-[11px]">
                  <span className="font-semibold text-slate-700">{action.actorName}</span>{" "}
                  <span className="text-slate-500">{action.verb.replace(".", " ")}</span>
                  <div className="text-slate-400">{dateTime(action.at)}</div>
                  {action.reason && <div className="mt-0.5 italic text-slate-500">“{action.reason}”</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        <SnapshotModal
          open={Boolean(selectedSnapshot)}
          onOpenChange={(open) => !open && setSelectedSnapshot(null)}
          snapshot={selectedSnapshot?.url ?? null}
          label={selectedSnapshot?.label ?? "Incident evidence"}
          metadata={selectedSnapshot?.metadata}
        />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // 4. Zone
  // ------------------------------------------------------------------
  if (result.kind === "zone" && zone) {
    const zoneCameras = cameras.filter((entry) =>
      entry.zones.some((cameraZone) => cameraZone.id === zone.zoneId),
    );
    const mappedCameras = zoneCameras
      .map((entry) => ({ camera: entry, placement: placementOf(entry.id) }))
      .filter((entry) => entry.placement);
    const zoneCenter: [number, number] = mappedCameras[0]
      ? [mappedCameras[0].placement!.at.lat, mappedCameras[0].placement!.at.lon]
      : DEFAULT_CENTER;

    return (
      <div className="flex h-full flex-col divide-y divide-blue-100 overflow-y-auto bg-[linear-gradient(180deg,#fff_0%,#f8fbff_100%)] text-slate-700">
        <div className="bg-white p-4">
          <h3 className="text-base font-bold text-slate-900">{zone.zoneName}</h3>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="outline" className="border-blue-100 bg-blue-50 font-mono text-xs capitalize text-blue-700">
              {zone.kind.replace("_", " ")}
            </Badge>
            {zone.sector && <span className="text-xs text-slate-500">Sector: {humanise(zone.sector)}</span>}
          </div>
        </div>

        <div className="space-y-2 p-4">
          <div className="text-xs font-medium text-slate-700">Zone map</div>
          <div className="relative z-0 h-44 overflow-hidden rounded-xl border border-blue-100">
            <MapContainer
              center={zoneCenter}
              zoom={14}
              style={{ height: "100%", width: "100%", background: "#eaf2ff" }}
              attributionControl={false}
              zoomControl={false}
            >
              <BasemapLayer basemap={basemap} />
              {mappedCameras.map(({ camera: cam, placement }) => (
                <CircleMarker
                  key={cam.id}
                  center={[placement!.at.lat, placement!.at.lon]}
                  radius={7}
                  pathOptions={{ color: "#2563eb", fillColor: "#3b82f6", fillOpacity: 0.9, weight: 2 }}
                >
                  <Popup>
                    <div className="font-sans text-xs font-semibold">{cam.name}</div>
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
          <div className="pt-1 text-xs font-medium text-slate-700">Cameras watching this zone</div>
          <div className="flex flex-wrap gap-1.5">
            {zone.camerasWatching.map((cam) => (
              <Badge key={cam} variant="secondary" className="bg-blue-50 text-xs text-blue-700">
                {cam}
              </Badge>
            ))}
          </div>
        </div>

        {multiple && (
          <div className="p-3">
            <ResultList
              label={multiple.label}
              items={multiple.items}
              onSelect={(item) => onSelectPrompt?.(followUpFor(item))}
              scannedNote={multiple.truncated ? "list is capped" : null}
            />
          </div>
        )}
      </div>
    );
  }

  // ------------------------------------------------------------------
  // 5. Multiple results — the list-first view
  // ------------------------------------------------------------------
  if (multiple) {
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto bg-[linear-gradient(180deg,#fff_0%,#f8fbff_100%)] p-3 text-slate-700">
        <EvidenceMap items={multiple.items} basemap={basemap} />
        <ResultList
          className="flex-1"
          label={multiple.label}
          items={multiple.items}
          onSelect={(item) => onSelectPrompt?.(followUpFor(item))}
          scannedNote={multiple.truncated ? `showing the first ${multiple.items.length} of more` : null}
        />
      </div>
    );
  }

  return <EmptyState />;
}
