import { Router } from "express";
import { clearTarget, getTarget, setTarget } from "../l3/target";
import { BadRequest } from "../l4/hooks";
import { readJson } from "../http";

/**
 * The live camera pipeline's read side of target search, and
 * people_ai_service.py's write side -- it already extracts the appearance
 * embedding from an operator's uploaded photo (POST /target on port 8002),
 * this is just where that embedding also lands so vision-service/main.py's per-camera
 * workers (a separate process, polling like modules/watchlist_client.py
 * already does for the watchlist) can compare against it too. No role gate,
 * same reasoning person_watchlist's enrolment POST has: this is an internal
 * service call relaying what an operator already did, not a new capability.
 */
export const targetRoutes = Router();

targetRoutes.get("/api/target", (_req, res) => {
  res.json(getTarget());
});

targetRoutes.post("/api/target", (req, res) => {
  const body = readJson<{ appearanceEmbedding?: unknown }>(req);
  if (
    !Array.isArray(body.appearanceEmbedding) ||
    body.appearanceEmbedding.some((n) => typeof n !== "number" || !Number.isFinite(n))
  ) {
    throw new BadRequest("appearanceEmbedding must be an array of finite numbers");
  }
  setTarget(body.appearanceEmbedding as number[]);
  res.status(201).json(getTarget());
});

targetRoutes.delete("/api/target", (_req, res) => {
  clearTarget();
  res.json({ ok: true });
});
