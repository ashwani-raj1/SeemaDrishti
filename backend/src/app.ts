import express, { type Express } from "express";
import cors from "cors";
import { CORS, flatQuery, handleErrors, notFound } from "./http";
import { systemRoutes } from "./routes/system";
import { incidentRoutes } from "./routes/incidents";
import { zoneRoutes } from "./routes/zones";
import { cameraRoutes } from "./routes/cameras";
import { watchlistRoutes } from "./routes/watchlist";
import { mediaRoutes } from "./routes/media";
import { ingressRoutes } from "./routes/ingress";
import { simRoutes } from "./routes/sim";
import { clipRoutes } from "./routes/clips";

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

  app.use(cors(CORS));
  app.use(
    express.json({
      // Every JSON body is parsed whatever its content-type says: the vision
      // service and the simulator are not browsers and do not always set one.
      type: () => true,
      // Plate detections can carry a base64 frame snapshot.
      limit: "10mb",
    }),
  );

  app.use(systemRoutes);
  app.use(incidentRoutes);
  app.use(zoneRoutes);
  app.use(cameraRoutes);
  app.use(watchlistRoutes);
  app.use(mediaRoutes);
  app.use(ingressRoutes);
  app.use(simRoutes);
  app.use(clipRoutes);

  app.use(notFound);
  app.use(handleErrors);

  return app;
}
