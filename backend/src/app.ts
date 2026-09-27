import express, { type Express } from "express";
import cors from "cors";
import { CORS, flatQuery, handleErrors, notFound } from "./http";
import { systemRoutes } from "./routes/system";
import { incidentRoutes } from "./routes/incidents";
import { zoneRoutes } from "./routes/zones";
import { cameraRoutes } from "./routes/cameras";
import { watchlistRoutes } from "./routes/watchlist";
import { personWatchlistRoutes } from "./routes/person_watchlist";
import { targetRoutes } from "./routes/target";
import { mediaRoutes } from "./routes/media";
import { ingressRoutes } from "./routes/ingress";
import { simRoutes } from "./routes/sim";
import { clipRoutes } from "./routes/clips";
import { settingsRoutes } from "./routes/settings";
import { requestLog } from "./core/logger";

/**
 * The node's HTTP surface, assembled but not listening.
 *
 * Kept apart from `server.ts` so the whole API can be exercised in a test
 * without binding a port or seeding the live database.
 */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  // One string per query key, never a nested object -- what `Query<K>` in
  // http.ts promises the routes.
  app.set("query parser", flatQuery);

  // First, so it sees everything -- including the 404s and preflights that
  // never reach a router.
  app.use(requestLog);
  app.use(cors(CORS));
  app.use(
    express.json({
      // Every JSON body is parsed whatever its content-type says: the vision
      // service and the simulator are not browsers and do not always set one.
      type: () => true,
      // Plate detections can carry a base64 frame snapshot, and an evidence
      // clip is about a megabyte of them.
      limit: "10mb",
    }),
  );

  app.use(systemRoutes);
  app.use(incidentRoutes);
  app.use(zoneRoutes);
  app.use(clipRoutes);
  app.use(cameraRoutes);
  // personWatchlistRoutes BEFORE watchlistRoutes: the plate watchlist's own
  // GET/PATCH/DELETE /api/watchlist/:id would otherwise treat "people" as an
  // id and swallow every /api/watchlist/people* request before this router
  // ever saw it (Express tries routers in registration order and stops at
  // the first path match). Registering the more specific /people literal
  // first fixes it without touching the plate watchlist's own routes; a real
  // plate id never matches anything in this router, so it still falls
  // through to watchlistRoutes exactly as before.
  app.use(personWatchlistRoutes);
  app.use(targetRoutes);
  app.use(watchlistRoutes);
  app.use(mediaRoutes);
  app.use(settingsRoutes);
  app.use(ingressRoutes);
  app.use(simRoutes);

  app.use(notFound);
  app.use(handleErrors);

  return app;
}
