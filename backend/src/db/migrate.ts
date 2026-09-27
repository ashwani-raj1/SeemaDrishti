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
 * Carry a renamed column's data across to its new name.
 *
 * Same gap as `addColumn`: renaming a column in schema.sql never reaches a
 * database that already has the table, and every query using the new name
 * then fails outright.
 */
function renameColumn(db: Database, table: string, from: string, to: string): void {
  if (!tableExists(db, table)) return;
  if (!hasColumn(db, table, from) || hasColumn(db, table, to)) return;
  db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  console.log(`renamed ${table}.${from} to ${to}`);
}

/**
 * Before the schema runs: if `zone` is still the old single-camera shape, move
 * it aside so the new definition can be created under the same name.
 */
export function migrateBefore(db: Database): boolean {
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
  renameColumn(db, "zone", "area", "sector");

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
        `INSERT INTO zone (id, org_id, site_id, name, kind, sector, active, created_at, updated_at)
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
