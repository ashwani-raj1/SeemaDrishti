/**
 * The one doorway to the edge node.
 *
 * Every mutating route on the backend needs an actor -- an unattributed change
 * is exactly what the audit log exists to make impossible -- so the actor
 * header is attached here rather than remembered at each call site.
 */
import type {
  Action, CameraDetail, CameraIncidents, ChainVerdict, CreateWatchlistInput,
  Decision, DetectVehicleInput, Health, HubCameraList, IbvapEvent, Incident,
  IncidentDetail, MonitoringZone, PlateDetection, Point, ServerConfig, SimStatus,
  UpdateWatchlistInput, WatchlistEntry, WatchlistStats,
  VehicleTrafficSummary,
} from "./types";

/**
 * Carries the status through, because the backend uses them deliberately:
 * 422 = a reason is required, 403 = wrong role, 404 = gone, 400 = bad field.
 * The screen behaves differently for each, so the status must survive.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const needsReason = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 422;

export const isForbidden = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 403;

let apiBase = "";
let actorId = "usr_operator";

export const configureApi = (base: string) => {
  apiBase = base.replace(/\/$/, "");
};
export const setActor = (id: string) => {
  actorId = id;
};
export const currentActorId = () => actorId;
export const apiUrl = (path: string) => `${apiBase}${path}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-ibvap-actor": actorId,
        ...init?.headers,
      },
    });
  } catch {
    // The post is meant to survive a dropped link; say so rather than showing
    // an empty screen that looks like "nothing is happening".
    throw new ApiError("edge node unreachable", 0);
  }

  const body = await response.text();
  const parsed = body ? (JSON.parse(body) as unknown) : null;

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return parsed as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

const qs = (params: Record<string, unknown>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

export type EventQuery = {
  camera_id?: string;
  zone_id?: string;
  kind?: string;
  severity?: string;
  class?: string;
  alertable?: boolean;
  since?: string;
  until?: string;
  after_seq?: number;
  limit?: number;
};

export const api = {
  health: () => request<Health>("/api/health"),
  config: () => request<ServerConfig>("/api/config"),

  incidents: (
    params: { status?: string; camera_id?: string; zone_id?: string; limit?: number } = {},
  ) =>
    request<Incident[]>(`/api/incidents${qs(params)}`),
  incident: (id: string) => request<IncidentDetail>(`/api/incidents/${id}`),
  /** Recording the decision IS the state change; there is no status column. */
  decide: (id: string, decision: Decision, reason?: string) =>
    post<Incident>(`/api/incidents/${id}/decision`, { decision, reason }),

  events: (params: EventQuery = {}) => request<IbvapEvent[]>(`/api/events${qs(params)}`),

  /** Supervisor only, and the search itself is written to the audit log. */
  history: (params: EventQuery & { reason?: string } = {}) =>
    request<{ query: unknown; results: IbvapEvent[] }>(`/api/history${qs(params)}`),

  audit: (params: Record<string, string | number | undefined> = {}) =>
    request<Action[]>(`/api/audit${qs(params)}`),
  verifyChain: () => request<ChainVerdict>("/api/audit/verify"),

  // ---- cameras --------------------------------------------------------

  cameras: () => request<CameraDetail[]>("/api/cameras"),

  /**
   * What the media hub is serving right now, joined with what the node knows.
   * Proxied by the node because the hub's control API sends no CORS header and
   * exposes camera credentials -- see backend/src/routes/media.ts.
   */
  mediaCameras: () => request<HubCameraList>("/api/media/cameras"),

  /**
   * Adopt a camera the hub is already serving. `id` MUST be the hub's path
   * name -- the vision service stamps it on every detection and the node
   * matches on it exactly.
   */
  createCamera: (body: { id: string; name?: string; reason?: string }) =>
    post<CameraDetail>("/api/cameras", body),
  camera: (id: string) => request<CameraDetail>(`/api/cameras/${id}`),

  /** Everything that has happened on one feed, plus what else watches it. */
  cameraIncidents: (id: string, params: { status?: string; limit?: number } = {}) =>
    request<CameraIncidents>(`/api/cameras/${id}/incidents${qs(params)}`),

  /** Supervisor only. Taking a feed out of service needs a stated reason. */
  updateCamera: (
    id: string,
    patch: { name?: string; streamUrl?: string | null; enabled?: boolean; reason?: string },
  ) => request<CameraDetail>(`/api/cameras/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  // ---- zones ----------------------------------------------------------
  // A zone is a named place watched by one or more cameras. Its own target
  // policy is one call; a camera's exceptions to it are another.

  zones: () => request<MonitoringZone[]>("/api/zones"),
  zone: (id: string) => request<MonitoringZone>(`/api/zones/${id}`),

  createZone: (body: {
    name: string;
    kind: string;
    sector?: string | null;
    cameraIds: string[];
    targets: Array<{ class: string; severity: string; action: string }>;
    reason?: string;
  }) => post<MonitoringZone>("/api/zones", body),

  updateZone: (
    id: string,
    patch: { name?: string; kind?: string; sector?: string | null; active?: boolean; reason?: string },
  ) => request<MonitoringZone>(`/api/zones/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteZone: (id: string, reason: string) =>
    request<{ ok: true }>(`/api/zones/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),

  /** Replaces the whole list -- position in the array is the priority. */
  setZoneTargets: (
    id: string,
    targets: Array<{ class: string; severity: string; action: string }>,
    reason?: string,
  ) =>
    request<MonitoringZone>(`/api/zones/${id}/targets`, {
      method: "PUT",
      body: JSON.stringify({ targets, reason }),
    }),

  addZoneCamera: (id: string, cameraId: string, reason?: string) =>
    post<MonitoringZone>(`/api/zones/${id}/cameras`, { cameraId, reason }),

  removeZoneCamera: (id: string, cameraId: string, reason: string) =>
    request<{ ok: true }>(`/api/zones/${id}/cameras/${cameraId}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    }),

  /** Move or retune one camera's shape within the zone. */
  updateZoneCamera: (
    id: string,
    cameraId: string,
    patch: {
      geometry?: string;
      points?: Point[];
      direction?: string;
      confirmSeconds?: number;
      reason?: string;
    },
  ) =>
    request<MonitoringZone>(`/api/zones/${id}/cameras/${cameraId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /** An empty list clears the exceptions and restores the zone policy. */
  setZoneCameraTargets: (
    id: string,
    cameraId: string,
    targets: Array<{ class: string; severity: string; action: string }>,
    reason?: string,
  ) =>
    request<MonitoringZone>(`/api/zones/${id}/cameras/${cameraId}/targets`, {
      method: "PUT",
      body: JSON.stringify({ targets, reason }),
    }),

  sim: () => request<SimStatus>("/api/sim"),
  simStart: (ambient = true) => post<SimStatus>("/api/sim/start", { ambient }),
  simStop: () => post<SimStatus>("/api/sim/stop"),
  simScenario: (name: string) =>
    post<{ spawned: unknown; status: SimStatus }>("/api/sim/scenario", { name }),

  // ---- watchlist & vehicle/plate detection (#36) ----------------------

  watchlist: (params: { search?: string; severity?: string; active?: boolean; limit?: number } = {}) =>
    request<WatchlistEntry[]>(`/api/watchlist${qs(params)}`),
  watchlistEntry: (id: string) => request<WatchlistEntry>(`/api/watchlist/${id}`),
  createWatchlistEntry: (body: CreateWatchlistInput) => post<WatchlistEntry>("/api/watchlist", body),
  updateWatchlistEntry: (id: string, patch: UpdateWatchlistInput) =>
    request<WatchlistEntry>(`/api/watchlist/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteWatchlistEntry: (id: string, reason: string) =>
    request<{ ok: true }>(`/api/watchlist/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
  watchlistStats: () => request<WatchlistStats>("/api/watchlist/stats"),
  vehicleTraffic: (params: { days?: number; camera_id?: string } = {}) =>
    request<VehicleTrafficSummary>(`/api/watchlist/traffic${qs(params)}`),
  recordVehicleTraffic: (body: { sourceKey: string; cameraId: string; vehicleType: string; occurredAt?: string }) =>
    post<{ recorded: boolean }>("/api/watchlist/traffic", body),
  plateDetections: (params: { match_status?: string; camera_id?: string; plate?: string; limit?: number } = {}) =>
    request<PlateDetection[]>(`/api/watchlist/detections${qs(params)}`),
  detectVehicleAndPlate: (body: DetectVehicleInput) => post<PlateDetection>("/api/watchlist/detect", body),
};


