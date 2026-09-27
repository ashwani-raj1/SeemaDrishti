/**
 * Mode 2: Manual Search.
 *
 * Deterministic filters straight against the existing API. No model is
 * involved anywhere in this file, and that is deliberate: when an operator
 * already knows the plate, the camera and the hour, they want the record --
 * not a paraphrase of it, and not a answer that depends on a network hop to
 * somebody else's datacentre.
 *
 * This is NOT the tool registry the AI chat uses. That is an internal
 * mechanism; this is an operator-facing search screen. They share the result
 * model and the list component, and nothing else.
 *
 * HONESTY ABOUT FILTERS: some of these controls have no server-side support.
 * `direction` is not a query parameter on the event endpoint, and neither
 * severity nor a time range exist on the incident or plate-detection
 * endpoints. Those are applied in the browser to the page of records the API
 * returned. That is a real limitation and the operator is told about it via
 * `scannedNote` rather than being shown a count that silently means something
 * narrower than it appears to.
 */
import { useEffect, useMemo, useState } from "react";
import { SearchIcon, SlidersHorizontalIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ibvap/spinner";
import { NothingHere } from "@/components/ibvap/states";
import { useClient } from "@/client/context";
import { api } from "@/lib/api";
import type { IbvapEvent, Incident, PlateDetection, Severity } from "@/lib/types";
import {
  detectionToItem,
  eventToItem,
  incidentToItem,
  sortItems,
  type IntelligenceResult,
  type NameLookup,
  type ResultItem,
} from "./result-model";
import { toolGetIncidentDetails, toolSearchCameraActivity, toolSearchVehicle } from "./intelligence-engine";
import { ResultList } from "./components/result-list";

const ALL = "__all__";

/** Records pulled per source before browser-side narrowing. */
const EVENT_CAP = 500;
const INCIDENT_CAP = 200;
const DETECTION_CAP = 200;

type SearchType = "all" | "vehicles" | "people" | "events" | "incidents";

const SEARCH_TYPES: Array<{ id: SearchType; label: string }> = [
  { id: "all", label: "All" },
  { id: "vehicles", label: "Vehicles" },
  { id: "people", label: "People" },
  { id: "events", label: "Events" },
  { id: "incidents", label: "Incidents" },
];

/** Only these can be narrowed to one vehicle, so only these show the field. */
const PLATE_TYPES: ReadonlySet<SearchType> = new Set(["all", "vehicles"]);

interface Filters {
  type: SearchType;
  plate: string;
  cameraId: string;
  zoneId: string;
  direction: string;
  severity: string;
  since: string;
  until: string;
}

const EMPTY_FILTERS: Filters = {
  type: "all",
  plate: "",
  cameraId: ALL,
  zoneId: ALL,
  direction: ALL,
  severity: ALL,
  since: "",
  until: "",
};

const toIso = (value: string) => (value ? new Date(value).toISOString() : undefined);

interface ManualSearchProps {
  /** Feeds the shared context panel on the right. */
  onResult: (result: IntelligenceResult) => void;
}

export function ManualSearch({ onResult }: ManualSearchProps) {
  const { cameras } = useClient();
  const [zones, setZones] = useState<Array<{ id: string; name: string }>>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState<ResultItem[] | null>(null);
  const [scannedNote, setScannedNote] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.zones()
      .then((result) => {
        if (!cancelled) setZones(result.map((zone) => ({ id: zone.id, name: zone.name })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const names: NameLookup = useMemo(
    () => ({
      cameraName: (id) => (id ? cameras.find((c) => c.id === id)?.name ?? id : null),
      zoneName: (id) => (id ? zones.find((z) => z.id === id)?.name ?? id : null),
    }),
    [cameras, zones],
  );

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  /**
   * Switching away from a vehicle search drops the plate. Leaving it in state
   * would keep scoping the next search -- invisibly, since the field is gone.
   */
  const chooseType = (type: SearchType) =>
    setFilters((prev) => ({ ...prev, type, plate: PLATE_TYPES.has(type) ? prev.plate : "" }));

  async function search() {
    setSearching(true);
    const cameraId = filters.cameraId === ALL ? undefined : filters.cameraId;
    const zoneId = filters.zoneId === ALL ? undefined : filters.zoneId;
    const severity = filters.severity === ALL ? undefined : (filters.severity as Severity);
    const since = toIso(filters.since);
    const until = toIso(filters.until);
    const wants = filters.type;

    // A plate identifies a vehicle, and only the detection record carries one.
    // Pulling events and incidents alongside it would pad the result with rows
    // that were never matched against the plate at all, so the search becomes
    // about that vehicle and nothing else.
    const plate = filters.plate.trim();
    const plateScoped = Boolean(plate);

    let found: ResultItem[] = [];
    let narrowed = false;
    let scanned = 0;

    try {
      // Each source is fetched only if this search type can use it. "All" runs
      // the three in parallel rather than in sequence -- an operator waiting on
      // a search is waiting on the slowest call, not the sum of them.
      const [events, incidents, detections] = await Promise.all([
        wants === "incidents" || plateScoped
          ? Promise.resolve(null)
          : api
              .events({
                class: wants === "people" ? "person" : undefined,
                camera_id: cameraId,
                zone_id: zoneId,
                severity,
                since,
                until,
                limit: EVENT_CAP,
              })
              .catch(() => [] as IbvapEvent[]),

        wants === "vehicles" || wants === "people" || wants === "events" || plateScoped
          ? Promise.resolve(null)
          : api
              .incidents({ camera_id: cameraId, zone_id: zoneId, limit: INCIDENT_CAP })
              .catch(() => [] as Incident[]),

        wants === "people" || wants === "events" || wants === "incidents"
          ? Promise.resolve(null)
          : api
              .plateDetections({
                plate: plate || undefined,
                camera_id: cameraId,
                limit: DETECTION_CAP,
              })
              .catch(() => [] as PlateDetection[]),
      ]);

      if (events) {
        const rows = events.map((event) => eventToItem(event, names));
        scanned += events.length;
        // `direction` has no server-side filter; the endpoint returns it, so
        // narrowing here is exact for the records we were given.
        const kept =
          filters.direction === ALL
            ? rows
            : rows.filter((row) => (row.direction ?? "").toLowerCase() === filters.direction);
        narrowed = narrowed || kept.length !== rows.length;
        found = found.concat(kept);
      }

      if (incidents) {
        // Neither severity nor a time window is a parameter on this endpoint.
        let rows = incidents.map((incident) => incidentToItem(incident, names));
        scanned += incidents.length;
        if (severity) rows = rows.filter((row) => row.severity === severity);
        if (since) rows = rows.filter((row) => row.occurredAt >= since);
        if (until) rows = rows.filter((row) => row.occurredAt <= until);
        narrowed = narrowed || rows.length !== incidents.length;
        found = found.concat(rows);
      }

      if (detections) {
        // No zone, severity or time parameter on this endpoint either.
        let rows = detections.map((detection) => detectionToItem(detection, names));
        scanned += detections.length;
        if (zoneId) rows = rows.filter((row) => row.zoneId === zoneId);
        if (severity) rows = rows.filter((row) => row.severity === severity);
        if (since) rows = rows.filter((row) => row.occurredAt >= since);
        if (until) rows = rows.filter((row) => row.occurredAt <= until);
        narrowed = narrowed || rows.length !== detections.length;
        found = found.concat(rows);
      }

      const sorted = sortItems(found);
      setItems(sorted);
      setScannedNote(
        narrowed
          ? `some filters applied to the most recent ${scanned} records`
          : null,
      );

      // Selecting the first match immediately is what makes the panel useful:
      // the operator searched, so they want to see something, not an empty map.
      const first = sorted[0] ?? null;
      setSelectedId(first?.id ?? null);
      if (first) void showDetail(first);
      else onResult({ kind: "none" });

      toast.success(`${sorted.length} matching record${sorted.length === 1 ? "" : "s"}`);
    } catch (cause) {
      setItems([]);
      setSelectedId(null);
      onResult({ kind: "none" });
      toast.error((cause as Error).message || "Search failed");
    } finally {
      setSearching(false);
    }
  }

  /** Loads the full record behind a list row into the shared context panel. */
  async function showDetail(item: ResultItem) {
    setSelectedId(item.id);
    try {
      if (item.status) {
        const detail = await toolGetIncidentDetails(item.id);
        onResult(detail ? { kind: "incident", incident: detail } : { kind: "none" });
        return;
      }
      if (item.plate) {
        const vehicle = await toolSearchVehicle(item.plate);
        onResult(
          vehicle
            ? {
                kind: "vehicle",
                vehicle,
                snapshot: vehicle.lastSeen?.snapshot
                  ? { url: vehicle.lastSeen.snapshot, label: `Last seen: ${vehicle.lastSeen.cameraName}` }
                  : null,
              }
            : { kind: "none" },
        );
        return;
      }
      if (item.cameraId) {
        const camera = await toolSearchCameraActivity(item.cameraId);
        onResult(camera ? { kind: "camera", camera } : { kind: "none" });
        return;
      }
      onResult({ kind: "none" });
    } catch {
      onResult({ kind: "none" });
    }
  }

  const resultCount = items?.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_8px_30px_rgba(37,99,235,.06)]">
      <div className="flex items-center justify-between border-b border-blue-100 bg-gradient-to-r from-blue-50/60 to-white px-5 py-3.5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-800 text-white shadow-sm">
            <SlidersHorizontalIcon className="h-4 w-4" />
          </div>
          <div>
            <span className="block text-sm font-semibold text-slate-900">Manual search</span>
            <span className="block text-[11px] text-slate-500">
              Exact filters against the record · no AI involved
            </span>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* Search type */}
        <div className="flex flex-wrap gap-1.5">
          {SEARCH_TYPES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => chooseType(entry.id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filters.type === entry.id
                  ? "border-slate-800 bg-slate-800 text-white"
                  : "border-blue-100 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <FieldGroup className="mt-4 grid gap-3 md:grid-cols-3">
          {PLATE_TYPES.has(filters.type) && (
            <Field>
              <FieldLabel htmlFor="ms-plate">Plate number</FieldLabel>
              <Input
                id="ms-plate"
                value={filters.plate}
                placeholder="PB 02 AK 4821"
                onChange={(event) => set("plate", event.target.value)}
              />
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="ms-camera">Camera</FieldLabel>
            <Select value={filters.cameraId} onValueChange={(value) => set("cameraId", value)}>
              <SelectTrigger id="ms-camera">
                <SelectValue placeholder="All cameras" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>All cameras</SelectItem>
                  {cameras.map((camera) => (
                    <SelectItem key={camera.id} value={camera.id}>
                      {camera.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="ms-zone">BOP / zone</FieldLabel>
            <Select value={filters.zoneId} onValueChange={(value) => set("zoneId", value)}>
              <SelectTrigger id="ms-zone">
                <SelectValue placeholder="All zones" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>All zones</SelectItem>
                  {zones.map((zone) => (
                    <SelectItem key={zone.id} value={zone.id}>
                      {zone.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="ms-direction">Direction</FieldLabel>
            <Select value={filters.direction} onValueChange={(value) => set("direction", value)}>
              <SelectTrigger id="ms-direction">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>Any direction</SelectItem>
                  <SelectItem value="inbound">Inbound</SelectItem>
                  <SelectItem value="outbound">Outbound</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="ms-severity">Severity</FieldLabel>
            <Select value={filters.severity} onValueChange={(value) => set("severity", value)}>
              <SelectTrigger id="ms-severity">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>Any severity</SelectItem>
                  <SelectItem value="INFO">INFO</SelectItem>
                  <SelectItem value="WARNING">WARNING</SelectItem>
                  <SelectItem value="CRITICAL">CRITICAL</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="ms-since">From</FieldLabel>
            <Input
              id="ms-since"
              type="datetime-local"
              value={filters.since}
              onChange={(event) => set("since", event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="ms-until">To</FieldLabel>
            <Input
              id="ms-until"
              type="datetime-local"
              value={filters.until}
              onChange={(event) => set("until", event.target.value)}
            />
          </Field>
        </FieldGroup>

        <div className="mt-4 flex items-center gap-2">
          <Button onClick={() => void search()} disabled={searching}>
            {searching ? <Spinner data-icon="inline-start" /> : <SearchIcon data-icon="inline-start" />}
            Search
          </Button>
          {items && <span className="text-xs text-slate-500">{resultCount} matching records</span>}
          {scannedNote && <span className="text-[11px] text-amber-600">· {scannedNote}</span>}
        </div>

        <div className="mt-4 border-t border-blue-100 pt-4">
          {items === null && (
            <NothingHere
              icon={SearchIcon}
              title="No search yet"
              description="Set a filter and search. Leaving everything blank returns the most recent records of each type."
            />
          )}
          {items && items.length === 0 && (
            <NothingHere
              icon={SearchIcon}
              title="Nothing matched"
              description="No records fit those filters. Widen the time range or clear a filter."
            />
          )}
          {items && items.length > 0 && (
            <ResultList
              label="Matching records"
              items={items}
              selectedId={selectedId}
              onSelect={(item) => void showDetail(item)}
              scannedNote={scannedNote}
            />
          )}
        </div>
      </div>
    </div>
  );
}
