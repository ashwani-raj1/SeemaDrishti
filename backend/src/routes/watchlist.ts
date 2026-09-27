import { DEFAULT_ORG } from "../db/seed";
import { Router } from "express";
import type { Severity } from "../core/types";
import { actorOf, NotFound, num, optionalJson, query, readJson, requireRole } from "../http";
import { BadRequest } from "../l4/hooks";
import {
  analyzeFrame,
  createWatchlistEntry,
  deleteWatchlistEntry,
  getWatchlistEntry,
  getWatchlistStats,
  listWatchlist,
  processVehicleAndPlateDetection,
  queryPlateDetections,
  simulatePresetPlateDetection,
  updateWatchlistEntry,
} from "../l3/watchlist";

type Box = [number, number, number, number];

/** POST /api/watchlist */
export interface CreateWatchlistBody {
  plateNumber?: string;
  vehicleType?: string;
  makeModel?: string | null;
  color?: string | null;
  severity?: Severity;
  flagReason?: string;
  notes?: string | null;
  active?: boolean;
}

/** PATCH /api/watchlist/:id */
export interface UpdateWatchlistBody extends CreateWatchlistBody {
  reason?: string;
}

/** DELETE /api/watchlist/:id */
export interface DeleteWatchlistBody {
  reason?: string;
}

/** POST /api/watchlist/detect */
export interface DetectBody {
  cameraId?: string;
  zoneId?: string | null;
  plateNumber?: string;
  vehicleType?: string;
  confidence?: number;
  plateConfidence?: number;
  bbox?: Box;
  plateBbox?: Box;
  imageSnapshot?: string | null;
  simulated?: boolean;
}

/** POST /api/watchlist/simulate */
export interface SimulateBody {
  preset?: string;
}

/** POST /api/watchlist/analyze-frame */
export interface AnalyzeFrameBody {
  cameraId?: string;
  zoneId?: string | null;
  timeOffset?: number;
  simulated?: boolean;
}

export const watchlistRoutes = Router();

watchlistRoutes.get("/api/watchlist", (req, res) => {
  const params = query<"search" | "severity" | "active" | "limit" | "offset">(req);
  res.json(
    listWatchlist(DEFAULT_ORG, {
      search: params.search,
      severity: params.severity,
      activeOnly: params.active === "true",
      limit: num(params.limit),
      offset: num(params.offset),
    }),
  );
});

watchlistRoutes.post("/api/watchlist", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const body = readJson<CreateWatchlistBody>(req);
  if (!body.plateNumber || typeof body.plateNumber !== "string" || !body.plateNumber.trim()) {
    throw new BadRequest("plateNumber is required");
  }
  if (!body.flagReason || typeof body.flagReason !== "string" || !body.flagReason.trim()) {
    throw new BadRequest("flagReason is required");
  }

  const created = createWatchlistEntry(
    {
      orgId: DEFAULT_ORG,
      plateNumber: body.plateNumber.trim(),
      vehicleType: body.vehicleType ?? "car",
      makeModel: body.makeModel ?? null,
      color: body.color ?? null,
      severity: body.severity ?? "WARNING",
      flagReason: body.flagReason.trim(),
      notes: body.notes ?? null,
      active: body.active !== false,
    },
    actor,
  );

  res.status(201).json(created);
});

watchlistRoutes.get("/api/watchlist/stats", (_req, res) => {
  res.json(getWatchlistStats(DEFAULT_ORG));
});

watchlistRoutes.get("/api/watchlist/detections", (req, res) => {
  const params = query<"match_status" | "camera_id" | "plate" | "limit" | "offset">(req);
  res.json(
    queryPlateDetections(DEFAULT_ORG, {
      matchStatus: params.match_status,
      cameraId: params.camera_id,
      plateNumber: params.plate,
      limit: num(params.limit, 50),
      offset: num(params.offset),
    }),
  );
});

watchlistRoutes.post("/api/watchlist/detect", (req, res) => {
  const body = readJson<DetectBody>(req);
  const cameraId = body.cameraId ?? "cam_fence_north";

  const detection = processVehicleAndPlateDetection({
    orgId: DEFAULT_ORG,
    cameraId,
    zoneId: body.zoneId ?? null,
    plateNumber: body.plateNumber,
    vehicleType: body.vehicleType ?? "car",
    confidence: typeof body.confidence === "number" ? body.confidence : 0.95,
    plateConfidence: typeof body.plateConfidence === "number" ? body.plateConfidence : 0.97,
    bbox: body.bbox,
    plateBbox: body.plateBbox,
    imageSnapshot: body.imageSnapshot ?? null,
    simulated: body.simulated !== false,
  });

  res.status(201).json(detection);
});

watchlistRoutes.post("/api/watchlist/simulate", (req, res) => {
  const body = optionalJson<SimulateBody>(req);
  const preset = body.preset ?? "flagged_scorpio";
  res.status(201).json(simulatePresetPlateDetection(preset, DEFAULT_ORG));
});

watchlistRoutes.post("/api/watchlist/analyze-frame", (req, res) => {
  const body = optionalJson<AnalyzeFrameBody>(req);
  res.json(
    analyzeFrame(DEFAULT_ORG, {
      cameraId: body.cameraId,
      zoneId: body.zoneId,
      timeOffset: body.timeOffset,
      simulated: body.simulated !== false,
    }),
  );
});

watchlistRoutes.get("/api/watchlist/:id", (req, res) => {
  const entry = getWatchlistEntry(req.params.id);
  if (!entry) throw new NotFound(`no watchlist entry ${req.params.id}`);
  res.json(entry);
});

watchlistRoutes.patch("/api/watchlist/:id", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const entryId = req.params.id;
  const before = getWatchlistEntry(entryId);
  if (!before) throw new NotFound(`no watchlist entry ${entryId}`);

  const body = readJson<UpdateWatchlistBody>(req);
  const updated = updateWatchlistEntry(
    entryId,
    {
      plateNumber: body.plateNumber,
      vehicleType: body.vehicleType,
      makeModel: body.makeModel,
      color: body.color,
      severity: body.severity,
      flagReason: body.flagReason,
      notes: body.notes,
      active: body.active,
      reason: body.reason ?? "Watchlist entry updated",
    },
    actor,
  );

  res.json(updated);
});

watchlistRoutes.delete("/api/watchlist/:id", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const entryId = req.params.id;
  const before = getWatchlistEntry(entryId);
  if (!before) throw new NotFound(`no watchlist entry ${entryId}`);

  const body = optionalJson<DeleteWatchlistBody>(req);
  const reason = body.reason?.trim();
  if (!reason) {
    throw new BadRequest("a reason is required to remove a vehicle from the watchlist");
  }

  deleteWatchlistEntry(entryId, reason, actor);
  res.json({ ok: true });
});
