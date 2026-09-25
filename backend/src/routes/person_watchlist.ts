import { DEFAULT_ORG } from "../db/seed";
import { actorOf, handled, json, NotFound, query, readJson } from "../http";
import { BadRequest } from "../l4/hooks";
import {
  deletePersonWatchlistEntryByName,
  getPersonWatchlistByName,
  listPersonWatchlist,
  upsertPersonWatchlistEntry,
} from "../l3/person_watchlist";

function requireEmbeddingArray(value: unknown, field: string): number[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new BadRequest(`${field} must be an array of finite numbers`);
  }
  return value as number[];
}

/**
 * The person watchlist's REST surface -- mirrors routes/watchlist.ts's shape
 * for the plate watchlist, but keyed by NAME rather than id everywhere a
 * caller touches it, because ibvap/people_ai_service.py's own /watchlist
 * routes (which this replaces the storage for) were already keyed that way,
 * and changing that contract would mean changing the frontend for no reason.
 *
 * NO ROLE GATE, unlike the plate watchlist's supervisor-only POST/PATCH/DELETE:
 * this is called by ibvap/people_ai_service.py on every enrolment, which is an
 * internal trusted service call with no operator session behind it (the same
 * reasoning /hooks/ingress/* is unauthenticated). An operator enrolling a
 * photo from the People page is exactly the field-level, low-ceremony use
 * this is for.
 */
export const personWatchlistRoutes = {
  "/api/watchlist/people": {
    GET: handled(async (req) => {
      const params = query(req);
      const entries = listPersonWatchlist(DEFAULT_ORG, {
        activeOnly: params.get("active") === "true",
      });
      return json(entries);
    }),

    POST: handled(async (req) => {
      const actor = actorOf(req);
      const body = await readJson(req);
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
        },
        actor,
      );
      return json(entry, 201);
    }),
  },

  "/api/watchlist/people/:name": {
    GET: handled(async (req: any) => {
      const entry = getPersonWatchlistByName(DEFAULT_ORG, decodeURIComponent(req.params.name));
      if (!entry) throw new NotFound(`no watchlist entry ${req.params.name}`);
      return json(entry);
    }),

    DELETE: handled(async (req: any) => {
      const actor = actorOf(req);
      deletePersonWatchlistEntryByName(DEFAULT_ORG, decodeURIComponent(req.params.name), actor);
      return json({ ok: true });
    }),
  },
} as const;
