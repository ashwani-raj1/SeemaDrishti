import { DEFAULT_ORG } from "../db/seed";
import { actorOf, handled, json, NotFound, query, readJson, requireRole } from "../http";
import { BadRequest } from "../l4/hooks";
import {
  createWatchlistEntry,
  deleteWatchlistEntry,
  getWatchlistEntry,
  getWatchlistStats,
  getVehicleTraffic,
  listWatchlist,
  processVehicleAndPlateDetection,
  queryPlateDetections,
  recordVehicleTraffic,
  updateWatchlistEntry,
} from "../l3/watchlist";

export const watchlistRoutes = {
  "/api/watchlist": {
    GET: handled(async (req) => {
      const params = query(req);
      const entries = listWatchlist(DEFAULT_ORG, {
        search: params.get("search") ?? undefined,
        severity: params.get("severity") ?? undefined,
        activeOnly: params.get("active") === "true",
        limit: params.has("limit") ? Number(params.get("limit")) : undefined,
        offset: params.has("offset") ? Number(params.get("offset")) : undefined,
      });
      return json(entries);
    }),

    POST: handled(async (req) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const body = await readJson(req);
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

      return json(created, 201);
    }),
  },

  "/api/watchlist/stats": handled(async () => json(getWatchlistStats(DEFAULT_ORG))),

  "/api/watchlist/traffic": {
    GET: handled(async (req) => {
      const params = query(req);
      return json(getVehicleTraffic(DEFAULT_ORG, {
        days: params.has("days") ? Number(params.get("days")) : 14,
        cameraId: params.get("camera_id") ?? undefined,
      }));
    }),
    POST: handled(async (req) => {
      const body = await readJson(req);
      if (!body.sourceKey || typeof body.sourceKey !== "string") {
        throw new BadRequest("sourceKey is required");
      }
      if (!body.cameraId || typeof body.cameraId !== "string") {
        throw new BadRequest("cameraId is required");
      }
      return json(recordVehicleTraffic({
        orgId: DEFAULT_ORG,
        cameraId: body.cameraId ?? "cam_fence_north",
        sourceKey: body.sourceKey,
        vehicleType: body.vehicleType ?? "vehicle",
        occurredAt: body.occurredAt,
      }), 201);
    }),
  },

  "/api/watchlist/detections": handled(async (req) => {
    const params = query(req);
    const detections = queryPlateDetections(DEFAULT_ORG, {
      matchStatus: params.get("match_status") ?? undefined,
      cameraId: params.get("camera_id") ?? undefined,
      plateNumber: params.get("plate") ?? undefined,
      limit: params.has("limit") ? Number(params.get("limit")) : undefined,
      offset: params.has("offset") ? Number(params.get("offset")) : undefined,
    });
    return json(detections);
  }),

  "/api/watchlist/detect": {
    POST: handled(async (req) => {
      const body = await readJson(req);
      const cameraId = body.cameraId ?? "cam_fence_north";
      if (!body.plateNumber || typeof body.plateNumber !== "string" || !body.plateNumber.trim()) {
        throw new BadRequest("plateNumber is required; no ANPR record was created");
      }

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
        simulated: body.simulated === true,
      });

      return json(detection, 201);
    }),
  },

  "/api/watchlist/:id": {
    GET: handled(async (req: any) => {
      const entry = getWatchlistEntry(req.params.id);
      if (!entry) throw new NotFound(`no watchlist entry ${req.params.id}`);
      return json(entry);
    }),

    PATCH: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const entryId = req.params.id;
      const before = getWatchlistEntry(entryId);
      if (!before) throw new NotFound(`no watchlist entry ${entryId}`);

      const body = await readJson(req);
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

      return json(updated);
    }),

    DELETE: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const entryId = req.params.id;
      const before = getWatchlistEntry(entryId);
      if (!before) throw new NotFound(`no watchlist entry ${entryId}`);

      const body = await readJson(req).catch(() => ({}) as Record<string, any>);
      const reason = body.reason?.trim();
      if (!reason) {
        throw new BadRequest("a reason is required to remove a vehicle from the watchlist");
      }

      deleteWatchlistEntry(entryId, reason, actor);
      return json({ ok: true });
    }),
  },
} as const;
