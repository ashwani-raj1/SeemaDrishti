/**
 * The one doorway to the edge node.
 *
 * Every mutating route on the backend needs an actor -- an unattributed change
 * is exactly what the audit log exists to make impossible -- so the actor
 * header is attached here rather than remembered at each call site.
 */
import type {
  Action, ChainVerdict, Decision, Health, IbvapEvent, Incident,
  IncidentDetail, ServerConfig, SimStatus, Zone,
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

  incidents: (params: { status?: string; limit?: number } = {}) =>
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

  zones: (cameraId?: string) => request<Zone[]>(`/api/zones${qs({ camera_id: cameraId })}`),
  updateZone: (id: string, patch: Partial<Zone> & { reason?: string }) =>
    request<Zone>(`/api/zones/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  sim: () => request<SimStatus>("/api/sim"),
  simStart: (ambient = true) => post<SimStatus>("/api/sim/start", { ambient }),
  simStop: () => post<SimStatus>("/api/sim/stop"),
  simScenario: (name: string) =>
    post<{ spawned: unknown; status: SimStatus }>("/api/sim/scenario", { name }),
};
