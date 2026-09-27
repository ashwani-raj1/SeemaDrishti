/**
 * Mode 1: the AI intelligence chat.
 *
 * Two rungs, and the operator cannot tell which one answered:
 *
 *   1. `/api/intelligence/ask` -- Gemini reads the question and drives the
 *      controlled tool registry on the node. Best natural-language coverage.
 *   2. `processIntelligenceQuery` -- the local regex/keyword engine. No
 *      network, no API key, no model.
 *
 * Rung 2 is not a degraded demo, it is the reason this screen still works at a
 * post with no connectivity. Rung 1 fails closed into it: any error at all --
 * missing key, timeout, malformed function call, unreachable node -- and the
 * engine answers instead. The operator never sees an error for a question the
 * node can answer from its own database.
 *
 * Both rungs produce the same `IntelligenceResult`, which is what lets the
 * evidence panel be shared with Manual Search.
 */
import { api } from "@/lib/api";
import { clockTime, formatPlate, humanise } from "@/lib/format";
import { ATTARI_SECTOR, gridRef, placementOf } from "@/client/geography";
import type {
  CameraDetail,
  IntelligenceEvidence,
  IbvapEvent,
  Incident,
  PlateDetection,
  Severity,
} from "@/lib/types";
import {
  eventToItem,
  incidentToItem,
  multipleResults,
  type CameraContextData,
  type IntelligenceResult,
  type NameLookup,
  type VehicleContextData,
} from "./result-model";
import { processIntelligenceQuery } from "./intelligence-engine";

export interface SystemMetadata {
  cameras: Array<{ id: string; name: string }>;
  zones: Array<{ id: string; name: string }>;
}

export interface AssistantAnswer {
  answer: string;
  suggestedPrompts: string[];
  result: IntelligenceResult;
  /**
   * Which rung answered. Used only to pick the loading wording and for
   * developer logging -- it is never rendered to the operator, because
   * "the model was down" is not information they can act on.
   */
  mode: "ai" | "local";
}

// ------------------------------------------------------------------ evidence payloads
// Mirrors of what the node's tool registry returns. Kept here rather than in
// lib/types.ts because they are an internal wire shape, not a REST resource.

interface VehicleEvidence {
  plateNumber: string;
  totalSightings: number;
  firstSeen: { occurredAt: string; cameraId: string; cameraName: string | null; zoneName: string | null } | null;
  lastSeen: {
    occurredAt: string;
    cameraId: string;
    cameraName: string | null;
    zoneName: string | null;
    snapshot: string | null;
  } | null;
  watchlist: {
    isMatch: boolean;
    severity: Severity | null;
    flagReason: string | null;
    notes: string | null;
    vehicleType: string | null;
    makeModel: string | null;
    color: string | null;
  };
  camerasVisited: Array<{ cameraId: string; cameraName: string; count: number; lastSeenAt: string }>;
  timeline: Array<{
    detectionId: string;
    cameraId: string;
    cameraName: string | null;
    zoneId: string | null;
    zoneName: string | null;
    occurredAt: string;
    confidence: number;
    matchStatus: string;
    severity: Severity;
    snapshot: string | null;
  }>;
}

interface CameraEvidence {
  camera: CameraDetail;
  recentEvents: IbvapEvent[];
  incidents: Incident[];
  recentPlates: PlateDetection[];
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function namesFrom(metadata: SystemMetadata): NameLookup {
  return {
    cameraName: (id) =>
      id ? metadata.cameras.find((c) => c.id === id)?.name ?? humanise(id) : null,
    zoneName: (id) =>
      id ? metadata.zones.find((z) => z.id === id)?.name ?? humanise(id) : null,
  };
}

// ------------------------------------------------------------------ evidence -> result

/**
 * The node does not know where its cameras are -- placement is deployment
 * configuration held in the frontend. So every coordinate, bearing and grid
 * reference is added here, on the way out, and never travels through the model.
 */
function vehicleFromEvidence(ev: VehicleEvidence, related: { incidents: Incident[]; events: IbvapEvent[] }): VehicleContextData {
  const lastPlacement = ev.lastSeen ? placementOf(ev.lastSeen.cameraId) : null;

  return {
    plateNumber: ev.plateNumber,
    formattedPlate: formatPlate(ev.plateNumber),
    vehicleType: ev.watchlist.vehicleType ?? "vehicle",
    makeModel: ev.watchlist.makeModel,
    color: ev.watchlist.color,
    confidence: ev.timeline[0]?.confidence ?? 0,
    totalSightings: ev.totalSightings,
    firstSeen: ev.firstSeen
      ? {
          occurredAt: ev.firstSeen.occurredAt,
          cameraId: ev.firstSeen.cameraId,
          cameraName: ev.firstSeen.cameraName ?? humanise(ev.firstSeen.cameraId),
          zoneName: ev.firstSeen.zoneName,
        }
      : null,
    lastSeen: ev.lastSeen
      ? {
          occurredAt: ev.lastSeen.occurredAt,
          cameraId: ev.lastSeen.cameraId,
          cameraName: ev.lastSeen.cameraName ?? humanise(ev.lastSeen.cameraId),
          zoneName: ev.lastSeen.zoneName,
          snapshot: ev.lastSeen.snapshot,
          coordinates: lastPlacement?.at ?? null,
          gridReference: lastPlacement ? gridRef(lastPlacement.at, ATTARI_SECTOR) : undefined,
        }
      : null,
    watchlistStatus: {
      isMatch: ev.watchlist.isMatch,
      flagReason: ev.watchlist.flagReason,
      severity: ev.watchlist.severity ?? (ev.watchlist.isMatch ? "WARNING" : "INFO"),
      notes: ev.watchlist.notes,
      entry: null,
    },
    timeline: ev.timeline.map((item) => {
      const placement = placementOf(item.cameraId);
      return {
        detectionId: item.detectionId,
        cameraId: item.cameraId,
        cameraName: item.cameraName ?? humanise(item.cameraId),
        zoneId: item.zoneId,
        zoneName: item.zoneName,
        occurredAt: item.occurredAt,
        confidence: item.confidence,
        matchStatus: item.matchStatus as VehicleContextData["timeline"][number]["matchStatus"],
        severity: item.severity,
        snapshot: item.snapshot,
        coordinates: placement?.at ?? null,
      };
    }),
    camerasVisited: ev.camerasVisited,
    relatedIncidents: related.incidents,
    relatedEvents: related.events,
    extraFields: {},
  };
}

function cameraFromEvidence(ev: CameraEvidence): CameraContextData {
  const placement = placementOf(ev.camera.id);
  return {
    cameraId: ev.camera.id,
    cameraName: ev.camera.name,
    status: ev.camera.status,
    enabled: ev.camera.enabled,
    coordinates: placement?.at ?? null,
    gridReference: placement ? gridRef(placement.at, ATTARI_SECTOR) : "N/A",
    bearing: placement?.bearing ?? 0,
    fovDeg: placement?.fovDeg ?? 70,
    rangeM: placement?.rangeM ?? 200,
    recentEvents: ev.recentEvents,
    incidents: ev.incidents,
    recentPlates: ev.recentPlates,
  };
}

/**
 * Collapses whatever the model chose to look at into one panel payload.
 *
 * A question can trigger several tool calls -- list cameras, then search
 * events -- so this picks the most specific evidence for the panel and folds
 * the rest in as related material. Specific beats general: a single vehicle
 * record is more useful than the incident list that happened to be fetched
 * alongside it.
 */
export function resultFromEvidence(evidence: IntelligenceEvidence[], names: NameLookup): IntelligenceResult {
  const incidents = evidence
    .filter((e) => e.kind === "incidents")
    .flatMap((e) => asArray<Incident>(e.result));

  const events = evidence
    .filter((e) => e.kind === "events")
    .flatMap((e) => asArray<IbvapEvent>(e.result));

  const vehicleEvidence = evidence.find((e) => e.kind === "vehicle")?.result as VehicleEvidence | null | undefined;
  if (vehicleEvidence) {
    const incidentDetail = evidence.find((e) => e.kind === "incident");
    const detailRecord = asRecord(incidentDetail?.result);
    const detailIncidents = asArray<Incident>(detailRecord?.incident ? [detailRecord.incident] : []);
    return {
      kind: "vehicle",
      vehicle: vehicleFromEvidence(vehicleEvidence, {
        incidents: [...incidents, ...detailIncidents],
        events,
      }),
      snapshot: vehicleEvidence.lastSeen?.snapshot
        ? {
            url: vehicleEvidence.lastSeen.snapshot,
            label: `Last seen: ${vehicleEvidence.lastSeen.cameraName ?? "camera"} · ${clockTime(vehicleEvidence.lastSeen.occurredAt)}`,
          }
        : null,
    };
  }

  const incidentDetail = evidence.find((e) => e.kind === "incident");
  if (incidentDetail) {
    const record = asRecord(incidentDetail.result);
    const incident = record?.incident as Incident | undefined;
    if (incident) {
      return {
        kind: "incident",
        incident: {
          incident,
          detail: null,
          cameraName: names.cameraName(incident.cameraId) ?? undefined,
          coordinates: incident.cameraId ? placementOf(incident.cameraId)?.at ?? null : null,
          gridReference: incident.cameraId
            ? (() => {
                const p = placementOf(incident.cameraId);
                return p ? gridRef(p.at, ATTARI_SECTOR) : undefined;
              })()
            : undefined,
          events: asArray<IbvapEvent>(record?.events),
          relatedIncidents: incidents.length ? incidents : undefined,
          actions: asArray<{ actor?: { name?: string }; verb?: string; reason?: string | null; at?: string }>(
            record?.actions,
          ).map((a) => ({
            actorName: a.actor?.name ?? "Unknown",
            verb: a.verb ?? "",
            reason: a.reason ?? null,
            at: a.at ?? "",
          })),
        },
      };
    }
  }

  const cameraEvidence = evidence.find((e) => e.kind === "camera")?.result as CameraEvidence | null | undefined;
  if (cameraEvidence?.camera) {
    const latestSnapshot = cameraEvidence.recentPlates?.[0]?.image_snapshot ?? null;
    return {
      kind: "camera",
      camera: cameraFromEvidence(cameraEvidence),
      snapshot: latestSnapshot
        ? { url: latestSnapshot, label: `Latest image from ${cameraEvidence.camera.name}` }
        : null,
    };
  }

  if (incidents.length) {
    return {
      kind: "multiple",
      multiple: multipleResults("Detected Issues", incidents.map((i) => incidentToItem(i, names)), {
        scannedCount: incidents.length,
      }),
    };
  }

  if (events.length) {
    return {
      kind: "multiple",
      events: { queryTitle: "Recorded events", count: events.length, events },
      multiple: multipleResults("Detected Issues", events.map((e) => eventToItem(e, names)), {
        scannedCount: events.length,
      }),
    };
  }

  // Inventory-only answers ("how many zones are active") have no evidence to
  // pin to a map. The answer text is the whole response.
  return { kind: "none" };
}

/** Follow-ups that make sense for what was just found. */
function promptsFor(result: IntelligenceResult): string[] {
  if (result.kind === "vehicle" && result.vehicle) {
    const plate = result.vehicle.formattedPlate;
    const camera = result.vehicle.lastSeen?.cameraName;
    return [
      `Show the timeline for ${plate}`,
      camera ? `Show details for ${camera}` : "Are there any open critical incidents?",
      "Show related fence crossings",
    ];
  }
  if (result.kind === "camera" && result.camera) {
    return [
      `Where is ${result.camera.cameraName} located?`,
      "Are there any open critical incidents?",
      "Show activity around Northern Fence",
    ];
  }
  if (result.kind === "incident") {
    return ["Are there any open critical incidents?", "Show activity around Northern Fence"];
  }
  return [
    "Find vehicle PB 02 AK 4821",
    "Are there any open critical incidents?",
    "What happened near the northern fence yesterday?",
  ];
}

// ------------------------------------------------------------------ the entry point

export async function askAssistant(
  question: string,
  metadata: SystemMetadata,
): Promise<AssistantAnswer> {
  const names = namesFrom(metadata);

  try {
    const { answer, evidence } = await api.intelligenceAsk({ question });
    if (answer.trim()) {
      const result = resultFromEvidence(evidence, names);
      return {
        answer: answer.trim(),
        suggestedPrompts: promptsFor(result),
        result,
        mode: "ai",
      };
    }
  } catch (cause) {
    // Expected whenever GenAI is unconfigured or the node is offline. Traced
    // for a developer, never surfaced: the fallback below is a real answer.
    console.debug("[intelligence] model path unavailable, using local engine", cause);
  }

  const local = await processIntelligenceQuery(question, metadata);
  return {
    answer: local.answer,
    suggestedPrompts: local.suggestedPrompts,
    result: local.result,
    mode: "local",
  };
}
