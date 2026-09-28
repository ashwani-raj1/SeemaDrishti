import { Router } from "express";
import { DEFAULT_ORG } from "../db/seed";
import { actorOf, NotFound, query, readJson, requireRole } from "../http";
import { BadRequest } from "../l4/hooks";
import { recordAction } from "../l3/audit";
import {
  deletePersonWatchlistEntryByName,
  getPersonWatchlistByGovtId,
  getPersonWatchlistByName,
  getPersonWatchlistByPlate,
  listPersonWatchlist,
  personDossier,
  updatePersonProfile,
  upsertPersonWatchlistEntry,
} from "../l3/person_watchlist";

function requireEmbeddingArray(value: unknown, field: string): number[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new BadRequest(`${field} must be an array of finite numbers`);
  }
  return value as number[];
}

function ownedPlatesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((p: unknown): p is string => typeof p === "string" && !!p.trim());
}

/**
 * The person watchlist's REST surface -- mirrors routes/watchlist.ts's shape
 * for the plate watchlist, but keyed by NAME rather than id everywhere a
 * caller touches it, because ibvap/people_ai_service.py's own /watchlist
 * routes (which this replaces the storage for) were already keyed that way,
 * and changing that contract would mean changing the frontend for no reason.
 *
 * NO ROLE GATE on enrolment, unlike the plate watchlist's supervisor-only
 * POST/PATCH/DELETE: this is called by ibvap/people_ai_service.py on every
 * enrolment, which is an internal trusted service call with no operator
 * session behind it (the same reasoning /hooks/ingress/* is unauthenticated).
 * An operator enrolling a photo from the People page is exactly the
 * field-level, low-ceremony use this is for.
 */
export const personWatchlistRoutes = Router();

personWatchlistRoutes.get("/api/watchlist/people", (req, res) => {
  const params = query<"active">(req);
  const entries = listPersonWatchlist(DEFAULT_ORG, { activeOnly: params.active === "true" });
  res.json(entries);
});

personWatchlistRoutes.post("/api/watchlist/people", (req, res) => {
  const actor = actorOf(req);
  const body = readJson<{
    name?: string; faceEmbedding?: unknown; appearanceEmbedding?: unknown;
    notes?: string; address?: string; ownedPlates?: unknown; govtId?: string;
  }>(req);
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    throw new BadRequest("name is required");
  }
  const faceEmbedding = requireEmbeddingArray(body.faceEmbedding, "faceEmbedding");
  const appearanceEmbedding = requireEmbeddingArray(body.appearanceEmbedding, "appearanceEmbedding");
  if (!faceEmbedding && !appearanceEmbedding) {
    throw new BadRequest("at least one of faceEmbedding or appearanceEmbedding is required");
  }

  const entry = upsertPersonWatchlistEntry(
    {
      orgId: DEFAULT_ORG,
      name: body.name.trim(),
      faceEmbedding,
      appearanceEmbedding,
      notes: body.notes ?? null,
      // undefined, not null, when the field is simply absent from the body:
      // upsertPersonWatchlistEntry's own `!== undefined` check is what keeps
      // a re-enrol (a new photo, nothing else sent) from silently wiping
      // profile data a previous enrolment or a PATCH already set. Collapsing
      // "not sent" into "clear it" here would defeat that check before it
      // ever runs -- this route did exactly that until it was caught here.
      address: body.address === undefined ? undefined : (typeof body.address === "string" ? body.address : null),
      ownedPlates: body.ownedPlates === undefined ? undefined : (ownedPlatesOf(body.ownedPlates) ?? []),
      govtId: body.govtId === undefined ? undefined
        : (typeof body.govtId === "string" && body.govtId.trim() ? body.govtId.trim() : null),
    },
    actor,
  );
  res.status(201).json(entry);
});

personWatchlistRoutes.get("/api/watchlist/people/:name", (req, res) => {
  const entry = getPersonWatchlistByName(DEFAULT_ORG, req.params.name);
  if (!entry) throw new NotFound(`no watchlist entry ${req.params.name}`);
  res.json(entry);
});

// Profile-only edit (address, owned plates) -- role-gated like the plate
// watchlist's own PATCH, unlike the enrol POST above: this touches no
// embedding, but it IS the mock data the person dossier page shows, and
// that deserves the same "a supervisor decided this" bar plate edits get.
personWatchlistRoutes.patch("/api/watchlist/people/:name", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");
  const body = readJson<{ address?: string | null; ownedPlates?: unknown; govtId?: string | null }>(req);
  const updated = updatePersonProfile(
    DEFAULT_ORG,
    req.params.name,
    {
      address: body.address !== undefined ? (typeof body.address === "string" ? body.address : null) : undefined,
      ownedPlates: ownedPlatesOf(body.ownedPlates),
      govtId: body.govtId !== undefined ? (typeof body.govtId === "string" ? body.govtId : null) : undefined,
    },
    actor,
  );
  res.json(updated);
});

personWatchlistRoutes.delete("/api/watchlist/people/:name", (req, res) => {
  const actor = actorOf(req);
  deletePersonWatchlistEntryByName(DEFAULT_ORG, req.params.name, actor);
  res.json({ ok: true });
});

// Supervisor-only and audited, the same bar routes/history.ts holds
// /api/history to: "who has been where" is exactly the kind of query that
// should never be answerable without a name attached to having asked it.
personWatchlistRoutes.get("/api/watchlist/people/:name/dossier", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");
  const name = req.params.name;
  const dossier = personDossier(DEFAULT_ORG, name);
  if (!dossier) throw new NotFound(`no watchlist entry ${name}`);
  recordAction({
    actor, orgId: DEFAULT_ORG, verb: "person_watchlist.dossier_view",
    targetType: "person_watchlist", targetId: dossier.profile.id,
    reason: "Person dossier viewed",
    detail: { name },
  });
  res.json(dossier);
});

// The two reverse lookups: "who is this ID" and "whose vehicle is this
// plate", each resolving straight to a full dossier in one call -- the
// SIH problem statement's own "connect the dots" ask (search a person or
// a plate, see everywhere either has been seen). Same role gate and audit
// as the name-keyed dossier above, for the same reason: this answers
// "where has this person been" regardless of which fact you searched by.
personWatchlistRoutes.get("/api/watchlist/people/lookup/by-govt-id/:govtId/dossier", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");
  const govtId = req.params.govtId;
  const profile = getPersonWatchlistByGovtId(DEFAULT_ORG, govtId);
  if (!profile) throw new NotFound(`no watchlist entry with govt id ${govtId}`);
  const dossier = personDossier(DEFAULT_ORG, profile.name)!;
  recordAction({
    actor, orgId: DEFAULT_ORG, verb: "person_watchlist.dossier_view",
    targetType: "person_watchlist", targetId: profile.id,
    reason: "Person dossier viewed (by government ID)",
    detail: { govtId },
  });
  res.json(dossier);
});

personWatchlistRoutes.get("/api/watchlist/people/lookup/by-plate/:plate/dossier", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");
  const plate = req.params.plate;
  const profile = getPersonWatchlistByPlate(DEFAULT_ORG, plate);
  if (!profile) throw new NotFound(`no watchlist entry owns a vehicle matching ${plate}`);
  const dossier = personDossier(DEFAULT_ORG, profile.name)!;
  recordAction({
    actor, orgId: DEFAULT_ORG, verb: "person_watchlist.dossier_view",
    targetType: "person_watchlist", targetId: profile.id,
    reason: "Person dossier viewed (by vehicle plate)",
    detail: { plate },
  });
  res.json(dossier);
});
