import { all, one, run, bool } from "../db";
import { id, nowIso } from "../core/ids";
import { recordAction } from "./audit";
import { publish } from "../l4/bus";
import { recordEvent } from "./events";

/**
 * The person watchlist -- named entries, matched by face/appearance embedding
 * rather than a plate string. See schema.sql's table comment for why this
 * holds vectors (computed by the vision service's own models) and not photos,
 * and why it is the one thing both ibvap/main.py and ibvap/people_ai_service.py
 * poll rather than each keeping their own list.
 */

export interface PersonWatchlistEntry {
  id: string;
  org_id: string;
  name: string;
  face_embedding: number[] | null;
  appearance_embedding: number[] | null;
  notes: string | null;
  active: boolean;
  added_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Actor {
  id: string;
  name: string;
  role: "operator" | "supervisor" | "admin";
}

export interface UpsertPersonWatchlistInput {
  orgId: string;
  name: string;
  faceEmbedding?: number[] | null;
  appearanceEmbedding?: number[] | null;
  notes?: string | null;
}

export function listPersonWatchlist(orgId: string, options: { activeOnly?: boolean } = {}): PersonWatchlistEntry[] {
  let sql = "SELECT * FROM person_watchlist WHERE org_id = $org";
  const params: Record<string, any> = { $org: orgId };
  if (options.activeOnly) sql += " AND active = 1";
  sql += " ORDER BY updated_at DESC";
  return all<any>(sql, params).map(shapePersonWatchlistEntry);
}

export function getPersonWatchlistEntry(id: string): PersonWatchlistEntry | null {
  const row = one<any>("SELECT * FROM person_watchlist WHERE id = $id", { $id: id });
  return row ? shapePersonWatchlistEntry(row) : null;
}

export function getPersonWatchlistByName(orgId: string, name: string): PersonWatchlistEntry | null {
  const row = one<any>(
    "SELECT * FROM person_watchlist WHERE org_id = $org AND name = $name",
    { $org: orgId, $name: name },
  );
  return row ? shapePersonWatchlistEntry(row) : null;
}

/**
 * Enrolling the same name twice overwrites the entry -- matching how the
 * People page's own UI has always treated a re-added name (see
 * people_ai_service.py's pre-existing "overwrites existing" docstring), now
 * just persisted here instead of in that one process's memory.
 */
export function upsertPersonWatchlistEntry(input: UpsertPersonWatchlistInput, actor: Actor): PersonWatchlistEntry {
  const existing = getPersonWatchlistByName(input.orgId, input.name);
  const at = nowIso();

  if (existing) {
    run(
      `UPDATE person_watchlist
          SET face_embedding = $face,
              appearance_embedding = $appearance,
              notes = $notes,
              active = 1,
              updated_at = $at
        WHERE id = $id`,
      {
        $id: existing.id,
        $face: input.faceEmbedding != null ? JSON.stringify(input.faceEmbedding) : null,
        $appearance: input.appearanceEmbedding != null ? JSON.stringify(input.appearanceEmbedding) : null,
        $notes: input.notes ?? existing.notes,
        $at: at,
      },
    );
    const updated = getPersonWatchlistEntry(existing.id)!;
    recordAction({
      actor, orgId: input.orgId, verb: "person_watchlist.update",
      targetType: "person_watchlist", targetId: existing.id,
      reason: "Watchlist entry re-enrolled",
      detail: { name: input.name, hasFace: !!input.faceEmbedding, hasAppearance: !!input.appearanceEmbedding },
    });
    publish({ type: "person_watchlist_change", data: { action: "update", entry: updated } });
    return updated;
  }

  const entryId = id("pw");
  run(
    `INSERT INTO person_watchlist
       (id, org_id, name, face_embedding, appearance_embedding, notes, active, added_by, created_at, updated_at)
     VALUES ($id, $org, $name, $face, $appearance, $notes, 1, $added_by, $at, $at)`,
    {
      $id: entryId,
      $org: input.orgId,
      $name: input.name,
      $face: input.faceEmbedding != null ? JSON.stringify(input.faceEmbedding) : null,
      $appearance: input.appearanceEmbedding != null ? JSON.stringify(input.appearanceEmbedding) : null,
      $notes: input.notes ?? null,
      $added_by: actor.name,
      $at: at,
    },
  );
  const created = getPersonWatchlistEntry(entryId)!;
  recordAction({
    actor, orgId: input.orgId, verb: "person_watchlist.add",
    targetType: "person_watchlist", targetId: entryId,
    reason: "Watchlist entry enrolled",
    detail: { name: input.name, hasFace: !!input.faceEmbedding, hasAppearance: !!input.appearanceEmbedding },
  });
  publish({ type: "person_watchlist_change", data: { action: "add", entry: created } });
  return created;
}

export function deletePersonWatchlistEntryByName(orgId: string, name: string, actor: Actor): void {
  const existing = getPersonWatchlistByName(orgId, name);
  if (!existing) return;
  run("DELETE FROM person_watchlist WHERE id = $id", { $id: existing.id });
  recordAction({
    actor, orgId, verb: "person_watchlist.delete",
    targetType: "person_watchlist", targetId: existing.id,
    reason: "Watchlist entry removed", before: existing,
  });
  publish({ type: "person_watchlist_change", data: { action: "delete", name } });
}

/**
 * Record a match as a durable, alertable event -- the same door
 * ibvap/modules/face.py's durable emission already walks through for other
 * event types (see core/dispatcher.py), so a match shows up in Incidents
 * exactly like a fence crossing does, and a query by camera+time across
 * several cameras IS the cross-camera "where has this person been seen"
 * path, built entirely from existing event history rather than a bespoke
 * pixel-space trail that could never span two physically different cameras.
 */
export function recordPersonWatchlistMatch(input: {
  orgId: string;
  siteId: string;
  cameraId: string;
  cameraName: string;
  entry: PersonWatchlistEntry;
  signal: "face" | "appearance";
  score: number;
  trackRef: string;
  bbox: [number, number, number, number];
  simulated: boolean;
  occurredAt: string;
}) {
  const severity = input.signal === "face" ? "WARNING" : "INFO" as const;
  return recordEvent({
    orgId: input.orgId,
    siteId: input.siteId,
    kind: "watchlist_match",
    sourceType: "camera",
    sourceId: input.cameraId,
    simulated: input.simulated,
    cameraId: input.cameraId,
    zoneId: null,
    class: "person",
    rule: `person_watchlist.${input.signal}`,
    confidence: input.score,
    severity,
    // Only a face match is alertable: an appearance-only hit is the same
    // clothing-colour signal the People page's own UI already calls "far
    // weaker" (see people.tsx's info box) -- worth logging, not worth waking
    // anyone, until it has a measured false-positive rate behind it. Same
    // reasoning ingestReidentification gives for staying INFO/not-alertable.
    alertable: input.signal === "face",
    suppressedReason: input.signal === "face" ? null : "appearance_only_signal",
    occurredAt: input.occurredAt,
    evidence: {
      matchedWatchlistId: input.entry.id,
      matchedName: input.entry.name,
      signal: input.signal,
      score: input.score,
      trackRef: input.trackRef,
      bbox: input.bbox,
      camera: input.cameraName,
    },
    groupKey: `${input.cameraId}:watchlist:${input.entry.id}`,
    title: `Watchlist match: ${input.entry.name} at ${input.cameraName}`,
  });
}

function shapePersonWatchlistEntry(row: any): PersonWatchlistEntry {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    face_embedding: row.face_embedding ? JSON.parse(row.face_embedding) : null,
    appearance_embedding: row.appearance_embedding ? JSON.parse(row.appearance_embedding) : null,
    notes: row.notes ?? null,
    active: bool(row.active),
    added_by: row.added_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
