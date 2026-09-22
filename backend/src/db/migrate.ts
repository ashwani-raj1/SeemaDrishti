import type { Database } from "bun:sqlite";
import { id, nowIso } from "../core/ids";

/**
 * Moving an existing post from one-zone-one-camera to a zone that spans them.
 *
 * The old `zone` table carried the camera, the shape and the class lists all in
 * one row. The new shape splits those three things apart, so a post that has
 * been running cannot simply be handed the new schema -- its zones have to be
 * carried across. That is what this does, once, on the first boot after the
 * change.
 *
 * It runs in two halves around the schema file, because the legacy table has to
 * be moved out of the way before `CREATE TABLE zone` can take its name.
 */

const LEGACY = "zone_legacy";

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name")
    .get({ $name: name });
  return row !== null;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

/**
 * Add a column an existing database has not seen.
 *
 * `CREATE TABLE IF NOT EXISTS` silently does nothing when the table is already
 * there, so a new column never reaches a database that has been running. This
 * closes that gap for the simple cases -- anything needing data moved gets its
 * own migration instead.
 */
function addColumn(db: Database, table: string, column: string, definition: string): void {
  if (!tableExists(db, table)) return;
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`added ${table}.${column}`);
}


/**
 * One camera, one zone: retire the duplicate bindings an older database has.
 *
 * MUST RUN BEFORE `schema.sql`. That file is applied whole on every boot, and
 * its `CREATE UNIQUE INDEX zone_camera_one_zone` THROWS if duplicates already
 * exist -- at module-import time, so the node would not boot and every test
 * file that imports `../db` would die with it. The seeded data itself has a
 * camera in two zones, so this is not a hypothetical.
 *
 * Rows are retired (`active = 0`), never deleted: past events point at them,
 * and their target overrides come back if the camera rejoins that zone.
 *
 * Which binding survives, in order: the one somebody actually DREW, then the
 * most recently touched, then the lowest id. Deterministic on purpose -- a
 * developer's laptop and a fresh checkout must agree, and so must two runs of
 * this function.
 */
function enforceOneZonePerCamera(db: Database): void {
  // migrateBefore also runs against a :memory: database with no tables at all.
  if (!tableExists(db, "zone_camera")) return;

  const losers = db
    .query(
      `SELECT id, zone_id, camera_id FROM zone_camera zc
        WHERE active = 1
          AND id != (SELECT k.id FROM zone_camera k
                      WHERE k.camera_id = zc.camera_id AND k.active = 1
                      ORDER BY k.placed DESC, k.updated_at DESC, k.id ASC
                      LIMIT 1)`,
    )
    .all() as Array<{ id: string; zone_id: string; camera_id: string }>;

  for (const row of losers) {
    db.query("UPDATE zone_camera SET active = 0, updated_at = $at WHERE id = $id").run({
      $at: nowIso(),
      $id: row.id,
    });
    detachments.push({ zoneId: row.zone_id, cameraId: row.camera_id, bindingId: row.id });
    console.log(`[migrate] detached ${row.camera_id} from ${row.zone_id}: one camera, one zone`);
  }
}

/**
 * Bindings this migration retired, for the audit row `server.ts` writes.
 *
 * Not recorded here: `l3/audit.ts` imports `../db`, which is the module
 * currently being constructed, so calling recordAction from inside a migration
 * is an import cycle. A change to what is being watched belongs in the hash
 * chain, so it is emitted from server.ts instead, immediately after seed().
 */
export interface Detachment {
  zoneId: string;
  cameraId: string;
  bindingId: string;
}
export const detachments: Detachment[] = [];

/**
 * `zone.sector` became `zone.area`.
 *
 * Two unrelated things were called "sector": the post a camera belongs to
 * (`camera.sector` = "bop_attari") and the stretch of ground a zone was cut
 * from. Same word, same console, different meaning -- and the zone one also
 * used to be an id into a hardcoded polygon list that no longer exists, so its
 * old values are labels now whether they were meant to be or not.
 *
 * `CREATE TABLE IF NOT EXISTS` never touches a database that already has
 * `zone`, so a running post would otherwise come back with `area` missing and
 * every zone's label stranded in a column nothing reads. Copy, then drop.
 *
 * The drop is guarded: on a SQLite too old for `DROP COLUMN` the spare column
 * is dead weight, which is a much better outcome than a node that will not
 * boot. Nothing reads `sector` after this.
 */
function renameZoneSectorToArea(db: Database): void {
  if (!tableExists(db, "zone")) return;
  if (!hasColumn(db, "zone", "sector")) return;

  addColumn(db, "zone", "area", "TEXT");
  // `area IS NULL` so re-running cannot overwrite a label somebody has since
  // edited with the stale value the old column still holds.
  const moved = db.run("UPDATE zone SET area = sector WHERE area IS NULL AND sector IS NOT NULL");
  console.log(`zone.sector -> zone.area (${moved.changes} carried across)`);

  try {
    db.exec("ALTER TABLE zone DROP COLUMN sector");
  } catch (cause) {
    console.warn(`zone.sector left in place, unused: ${(cause as Error).message}`);
  }
}

/**
 * Before the schema runs: if `zone` is still the old single-camera shape, move
 * it aside so the new definition can be created under the same name.
 */
export function migrateBefore(db: Database): boolean {
  // Before both early returns below: they fire for any database that is
  // already on the new shape, which is every database that needs this.
  enforceOneZonePerCamera(db);

  if (!tableExists(db, "zone")) return false;
  if (!hasColumn(db, "zone", "camera_id")) return false; // already migrated

  // A half-finished previous attempt would otherwise block the rename.
  if (tableExists(db, LEGACY)) db.exec(`DROP TABLE ${LEGACY}`);

  db.exec(`ALTER TABLE zone RENAME TO ${LEGACY}`);
  db.exec("DROP INDEX IF EXISTS zone_by_camera");
  return true;
}

interface LegacyZone {
  id: string;
  camera_id: string;
  org_id: string;
  name: string;
  kind: string;
  geometry: string;
  points: string;
  watch_classes: string;
  log_only_classes: string;
  direction: string;
  confirm_seconds: number;
  severity: string;
  active: number;
  created_at: string;
  updated_at: string;
}

/**
 * After the schema runs: replay each legacy zone into the three new tables.
 *
 * Every legacy zone becomes a zone with exactly one camera in it, which is
 * behaviour-preserving -- nothing starts watching anything it was not watching
 * before. Its two class lists become ordered targets: watched classes first at
 * the zone's severity, then the log-only classes, which keeps the animal
 * suppression (#12) intact.
 */
export function migrateAfter(db: Database): void {
  // Columns first: these apply whether or not there is a legacy zone table.
  addColumn(db, "camera", "enabled", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "camera", "updated_at", "TEXT");
  // The frame a crossing was judged on. Nullable with no default, so every
  // event already on disk keeps its meaning: "no picture was ever taken",
  // which is exactly what was true before the vision service started sending
  // one.
  addColumn(db, "event", "thumbnail", "TEXT");
  // The incident grouping window, which used to be a constant in l3/events.ts.
  // The default is the value that constant held, so a node that upgrades keeps
  // grouping exactly as it did until somebody deliberately changes it.
  addColumn(db, "organisation", "grouping_window_seconds", "INTEGER NOT NULL DEFAULT 300");
  renameZoneSectorToArea(db);

  if (!tableExists(db, LEGACY)) return;

  const legacy = db.query(`SELECT * FROM ${LEGACY}`).all() as LegacyZone[];
  const at = nowIso();

  const carry = db.transaction(() => {
    for (const old of legacy) {
      const site = db
        .query("SELECT site_id FROM camera WHERE id = $camera")
        .get({ $camera: old.camera_id }) as { site_id: string } | null;

      // A zone whose camera has since been deleted has nowhere to live.
      if (!site) continue;

      db.query(
        `INSERT INTO zone (id, org_id, site_id, name, kind, area, active, created_at, updated_at)
         VALUES ($id, $org, $site, $name, $kind, NULL, $active, $created, $updated)`,
      ).run({
        $id: old.id,
        $org: old.org_id,
        $site: site.site_id,
        $name: old.name,
        $kind: old.kind,
        $active: old.active,
        $created: old.created_at,
        $updated: old.updated_at,
      });

      db.query(
        `INSERT INTO zone_camera
           (id, zone_id, camera_id, geometry, points, direction, confirm_seconds, placed, active, created_at, updated_at)
         VALUES ($id, $zone, $camera, $geometry, $points, $direction, $confirm, 1, $active, $created, $updated)`,
      ).run({
        $id: id("zc"),
        $zone: old.id,
        $camera: old.camera_id,
        $geometry: old.geometry,
        $points: old.points,
        $direction: old.direction,
        $confirm: old.confirm_seconds,
        $active: old.active,
        $created: old.created_at,
        $updated: old.updated_at,
      });

      const parse = (json: string): string[] => {
        try {
          const value = JSON.parse(json);
          return Array.isArray(value) ? value : [];
        } catch {
          return [];
        }
      };

      let priority = 1;
      const insertTarget = db.query(
        `INSERT OR IGNORE INTO zone_target
           (id, zone_id, camera_id, class, severity, action, priority, created_at, updated_at)
         VALUES ($id, $zone, NULL, $class, $severity, $action, $priority, $at, $at)`,
      );

      for (const className of parse(old.watch_classes)) {
        insertTarget.run({
          $id: id("tgt"),
          $zone: old.id,
          $class: className,
          $severity: old.severity,
          $action: "alert",
          $priority: priority++,
          $at: at,
        });
      }
      for (const className of parse(old.log_only_classes)) {
        insertTarget.run({
          $id: id("tgt"),
          $zone: old.id,
          $class: className,
          $severity: "INFO",
          $action: "log_only",
          $priority: priority++,
          $at: at,
        });
      }
    }

    db.exec(`DROP TABLE ${LEGACY}`);
  });

  carry();
  console.log(`migrated ${legacy.length} zone(s) to the multi-camera shape`);
}
