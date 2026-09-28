/**
 * The one-off target search's read side for the live camera pipeline.
 *
 * Deliberately NOT a database table, unlike person_watchlist: a target is
 * one operator's one-off "who does this look like", scoped to their current
 * session, never named, never meant to survive a restart or be looked up
 * later -- storing it durably would misrepresent what it is. An in-memory
 * singleton is the honest shape for that, the same way
 * people_ai_service.py's own target_embedding has always lived in memory,
 * not a database row.
 *
 * APPEARANCE ONLY, ON PURPOSE: target search has never used a face
 * embedding (see people_ai_service.py's own docstring on why -- "colour-
 * based re-association, not recognition"). This mirrors that exactly rather
 * than quietly gaining a face signal the rest of the feature does not have.
 *
 * Single-tenant for now: one target, not one per org. Fine while this is a
 * single-post deployment; the moment two orgs share a node, this needs the
 * same org-keyed shape person_watchlist already has.
 */

let current: { appearanceEmbedding: number[]; setAt: string } | null = null;

export function getTarget(): { appearanceEmbedding: number[]; setAt: string } | null {
  return current;
}

export function setTarget(appearanceEmbedding: number[]): void {
  current = { appearanceEmbedding, setAt: new Date().toISOString() };
}

export function clearTarget(): void {
  current = null;
}
