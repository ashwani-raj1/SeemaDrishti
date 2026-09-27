import { Router } from "express";
import { all, one } from "../db";
import { DEFAULT_ORG, DEFAULT_SITE } from "../db/seed";
import { nowIso } from "../core/ids";
import { mediaConfig } from "../core/env";
import { SEVERITY_RANK, type Role, type Severity } from "../core/types";
import { liveTrackCount } from "../l2/fence";
import { listZones, zonesForCamera } from "../l3/zones";
import { streamTo, subscriberCount } from "../l4/bus";
import * as sim from "../sim/simulator";

/**
 * The node describing itself: is it up, what is it configured with, and the
 * live stream that carries everything else as it happens.
 */

/** GET /api/health */
export interface HealthResponse {
  ok: true;
  at: string;
  liveTracks: number;
  streamSubscribers: number;
  simulator: ReturnType<typeof sim.status>;
}

export const systemRoutes = Router();

systemRoutes.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    at: nowIso(),
    liveTracks: liveTrackCount(),
    streamSubscribers: subscriberCount(),
    simulator: sim.status(),
  } satisfies HealthResponse);
});

/** Live push: events, incidents and decisions as they happen. */
systemRoutes.get("/api/stream", (req, res) => {
  streamTo(req, res);
});

systemRoutes.get("/api/config", (_req, res) => {
  const site = one<any>("SELECT * FROM site WHERE id = $id", { $id: DEFAULT_SITE });
  const cameras = all<any>("SELECT * FROM camera WHERE site_id = $site ORDER BY name", {
    $site: DEFAULT_SITE,
  });
  res.json({
    org: one<any>("SELECT * FROM organisation WHERE id = $id", { $id: DEFAULT_ORG }),
    site,
    users: all<{ id: string; name: string; role: Role }>(
      "SELECT id, name, role FROM app_user WHERE org_id = $org",
      { $org: DEFAULT_ORG },
    ),
    // Where the console gets video and live boxes. Addresses only -- a real
    // camera's RTSP credentials stay in media/cameras.yml on the hub machine
    // and never enter this database or this response.
    media: mediaConfig(),
    // A camera reaches its zones through the binding table now, and each
    // one arrives already resolved -- this camera's shape, and the target
    // list after any camera override.
    cameras: cameras.map((camera) => ({
      id: camera.id,
      name: camera.name,
      status: camera.status,
      // The hub path for this camera's video. Identical to its id on
      // purpose: whether that path is fed by a looping clip or a camera on
      // a wall is invisible from here, which is what makes the swap a
      // config change rather than a code change.
      streamPath: camera.id,
      zones: zonesForCamera(camera.id).map((zone) => ({
        id: zone.id,
        bindingId: zone.bindingId,
        cameraId: zone.camera_id,
        name: zone.name,
        kind: zone.kind,
        geometry: zone.geometry,
        points: zone.points,
        direction: zone.direction,
        confirmSeconds: zone.confirm_seconds,
        targets: zone.targets,
        // Derived from the targets, for the map tooltips and status board
        // that only ever want "what is alerted on here, and how loudly".
        // Kept as views so there is still one source of truth.
        watchClasses: zone.targets.filter((t) => t.action === "alert").map((t) => t.class),
        logOnlyClasses: zone.targets.filter((t) => t.action === "log_only").map((t) => t.class),
        severity: zone.targets
          .filter((t) => t.action === "alert")
          .reduce<Severity>(
            (worst, t) => (SEVERITY_RANK[t.severity] > SEVERITY_RANK[worst] ? t.severity : worst),
            "INFO",
          ),
        active: zone.active,
      })),
    })),
    zones: listZones(DEFAULT_SITE),
  });
});
