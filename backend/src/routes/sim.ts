import { Router } from "express";
import { BadRequest } from "../l4/hooks";
import { optionalJson, readJson } from "../http";
import * as sim from "../sim/simulator";

/** The simulator's controls, so a demo can be driven from the console. */

/** POST /api/sim/start */
export interface SimStartBody {
  ambient?: boolean;
}

/** POST /api/sim/scenario */
export interface SimScenarioBody {
  name?: sim.ScenarioName;
}

export const simRoutes = Router();

simRoutes.get("/api/sim", (_req, res) => {
  res.json(sim.status());
});

simRoutes.post("/api/sim/start", (req, res) => {
  const body = optionalJson<SimStartBody>(req);
  sim.start(body.ambient !== false);
  res.json(sim.status());
});

simRoutes.post("/api/sim/stop", (_req, res) => {
  sim.stop();
  res.json(sim.status());
});

simRoutes.post("/api/sim/scenario", (req, res) => {
  const { name } = readJson<SimScenarioBody>(req);
  if (!name || !sim.status().scenarios.includes(name)) {
    throw new BadRequest(`unknown scenario ${name}`);
  }
  res.json({ spawned: sim.runScenario(name), status: sim.status() });
});
