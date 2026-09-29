import { all, one, run, bool } from "../db";
import { id, nowIso } from "../core/ids";
import { recordAction } from "./audit";
import { publish } from "../l4/bus";
import { recordEvent, queryEvents } from "./events";
import { normalizePlate } from "./watchlist";

/**
 * The person watchlist -- named entries, matched by face/appearance embedding
 * rather than a plate string. See schema.sql's table comment for why this
 * holds vectors (computed by the vision service's own models) and not photos,
 * and why it is the one thing both vision-service/main.py and vision-service/people_ai_service.py
 * poll rather than each keeping their own list.
 */

export interface PersonWatchlistEntry {
  id: string;
  org_id: string;
  name: string;
  face_embedding: number[] | null;
  appearance_embedding: number[] | null;
  notes: string | null;
  /** MOCK -- see schema.sql's table comment. Operator-entered, never derived. */
  address: string | null;
  /** MOCK ownership claim -- the plate strings themselves are real ANPR
   * vocabulary (formatPlate's own shape), the claim that this person owns
   * them is not. */
  owned_plates: string[];
  /** MOCK -- stands in for a government ID registry, see schema.sql. */
  govt_id: string | null;
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
  address?: string | null;
  ownedPlates?: string[] | null;
  govtId?: string | null;
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

/** MOCK lookup -- see schema.sql's own note on govt_id. */
export function getPersonWatchlistByGovtId(orgId: string, govtId: string): PersonWatchlistEntry | null {
  const row = one<any>(
    "SELECT * FROM person_watchlist WHERE org_id = $org AND govt_id = $id",
    { $org: orgId, $id: govtId },
  );
  return row ? shapePersonWatchlistEntry(row) : null;
}

/**
 * "Whose vehicle is this" -- the reverse of personDossier's own plate
 * cross-reference. Filtered in JS over a bounded active set (the org's
 * whole watchlist, realistically small -- see personDossier's own comment
 * on why this is fine at demo-post scale), normalizing both sides the same
 * way personDossier does, for the same reason: comparing a raw plate
 * string against formatPlate()-shaped owned_plates would miss real matches
 * on spacing alone.
 */
export function getPersonWatchlistByPlate(orgId: string, plate: string): PersonWatchlistEntry | null {
  const normalized = normalizePlate(plate);
  if (!normalized) return null;
  const entries = listPersonWatchlist(orgId, { activeOnly: true });
  return entries.find((entry) => entry.owned_plates.some((p) => normalizePlate(p) === normalized)) ?? null;
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
              address = $address,
              owned_plates = $plates,
              govt_id = $govtId,
              active = 1,
              updated_at = $at
        WHERE id = $id`,
      {
        $id: existing.id,
        $face: input.faceEmbedding != null ? JSON.stringify(input.faceEmbedding) : null,
        $appearance: input.appearanceEmbedding != null ? JSON.stringify(input.appearanceEmbedding) : null,
        $notes: input.notes ?? existing.notes,
        $address: input.address !== undefined ? input.address : existing.address,
        $plates: input.ownedPlates !== undefined
          ? JSON.stringify(input.ownedPlates ?? [])
          : JSON.stringify(existing.owned_plates),
        $govtId: input.govtId !== undefined ? input.govtId : existing.govt_id,
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
       (id, org_id, name, face_embedding, appearance_embedding, notes, address, owned_plates, govt_id, active, added_by, created_at, updated_at)
     VALUES ($id, $org, $name, $face, $appearance, $notes, $address, $plates, $govtId, 1, $added_by, $at, $at)`,
    {
      $id: entryId,
      $org: input.orgId,
      $name: input.name,
      $face: input.faceEmbedding != null ? JSON.stringify(input.faceEmbedding) : null,
      $appearance: input.appearanceEmbedding != null ? JSON.stringify(input.appearanceEmbedding) : null,
      $notes: input.notes ?? null,
      $address: input.address ?? null,
      $plates: JSON.stringify(input.ownedPlates ?? []),
      $govtId: input.govtId ?? null,
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

/**
 * Editing the mock profile fields alone -- an operator filling in "where
 * this person lives" or "what they drive" without re-enrolling a photo.
 * Deliberately its own function rather than overloading upsertPersonWatchlistEntry:
 * that one REQUIRES at least one embedding signal (it is how a new entry is
 * born); this one requires the entry to already exist and touches neither
 * embedding, so the two can never be confused about what they are for.
 */
export function updatePersonProfile(
  orgId: string,
  name: string,
  patch: { address?: string | null; ownedPlates?: string[]; govtId?: string | null },
  actor: Actor,
): PersonWatchlistEntry {
  const existing = getPersonWatchlistByName(orgId, name);
  if (!existing) throw new Error(`no watchlist entry ${name}`);
  const at = nowIso();
  run(
    `UPDATE person_watchlist SET address = $address, owned_plates = $plates, govt_id = $govtId, updated_at = $at WHERE id = $id`,
    {
      $id: existing.id,
      $address: patch.address !== undefined ? patch.address : existing.address,
      $plates: JSON.stringify(patch.ownedPlates !== undefined ? patch.ownedPlates : existing.owned_plates),
      $govtId: patch.govtId !== undefined ? patch.govtId : existing.govt_id,
      $at: at,
    },
  );
  const updated = getPersonWatchlistEntry(existing.id)!;
  recordAction({
    actor, orgId, verb: "person_watchlist.update_profile",
    targetType: "person_watchlist", targetId: existing.id,
    reason: "Profile details edited",
    detail: { name, address: patch.address, ownedPlates: patch.ownedPlates, govtId: patch.govtId },
  });
  publish({ type: "person_watchlist_change", data: { action: "update", entry: updated } });
  return updated;
}

export interface PersonDossierSighting {
  cameraId: string | null;
  cameraName: string;
  signal: "face" | "appearance";
  score: number;
  occurredAt: string;
}

export interface PersonDossierVehicleSighting {
  plateNumber: string;
  cameraId: string;
  cameraName?: string;
  confidence: number;
  matchStatus: string;
  occurredAt: string;
}

export interface PersonDossier {
  profile: PersonWatchlistEntry;
  sightings: PersonDossierSighting[];
  vehicleSightings: PersonDossierVehicleSighting[];
}

/**
 * One person's whole picture: real sighting history (from durable
 * watchlist_match events, see recordPersonWatchlistMatch below) plus real
 * ANPR reads of the plates they are mock-recorded as owning. Two REAL data
 * sources -- a camera actually saw a face/appearance, a camera actually
 * read a plate -- joined through ONE mock fact (this plate belongs to this
 * person). The dossier UI must keep that distinction visible, not flatten
 * "real sighting of a mock-linked plate" into "confirmed sighting of this
 * person": the plate could belong to someone else entirely.
 */
export function personDossier(orgId: string, name: string): PersonDossier | null {
  const profile = getPersonWatchlistByName(orgId, name);
  if (!profile) return null;

  const sightings: PersonDossierSighting[] = queryEvents(orgId, { kind: "watchlist_match", limit: 500 })
    .filter((event) => (event.evidence as any)?.matchedWatchlistId === profile.id)
    .map((event) => ({
      cameraId: event.cameraId,
      cameraName: (event.evidence as any)?.camera ?? event.cameraId ?? "unknown camera",
      signal: (event.evidence as any)?.signal === "appearance" ? "appearance" : "face",
      score: typeof (event.evidence as any)?.score === "number" ? (event.evidence as any).score : event.confidence ?? 0,
      occurredAt: event.occurredAt,
    }));

  // A bounded recent window, filtered in JS by normalized plate equality --
  // NOT the LIKE-based substring filter queryPlateDetections offers, which
  // compares a normalized (no-space) search term against the DB's
  // SPACED, formatPlate()-shaped column and so can miss a real match (see
  // this session's own ANPR investigation). Small scale is fine here: this
  // is a demo-post log, not a national database (same reasoning
  // queryEvents's own 500-row cap already accepts elsewhere).
  const wanted = new Set(profile.owned_plates.map(normalizePlate));
  const vehicleSightings: PersonDossierVehicleSighting[] = wanted.size === 0 ? [] : all<any>(
    `SELECT pd.*, c.name AS camera_name FROM plate_detection pd
       LEFT JOIN camera c ON c.id = pd.camera_id
      WHERE pd.org_id = $org ORDER BY pd.occurred_at DESC LIMIT 500`,
    { $org: orgId },
  )
    .filter((row) => wanted.has(normalizePlate(row.plate_number)))
    .map((row) => ({
      plateNumber: row.plate_number,
      cameraId: row.camera_id,
      cameraName: row.camera_name,
      confidence: row.confidence,
      matchStatus: row.match_status,
      occurredAt: row.occurred_at,
    }));

  return { profile, sightings, vehicleSightings };
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
 * vision-service/modules/face.py's durable emission already walks through for other
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
    address: row.address ?? null,
    owned_plates: row.owned_plates ? JSON.parse(row.owned_plates) : [],
    govt_id: row.govt_id ?? null,
    active: bool(row.active),
    added_by: row.added_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
