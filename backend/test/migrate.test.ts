import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateAfter, migrateBefore } from "../src/db/migrate";

/**
 * Carrying a running post across the schema change.
 *
 * This is the one piece that only ever executes on somebody else's machine,
 * against data this code has never seen, exactly once -- so it is tested
 * against a hand-built copy of the old shape rather than trusted.
 */

const SCHEMA = readFileSync(join(import.meta.dir, "..", "src", "db", "schema.sql"), "utf8");

let db: Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

/** The tables as they stood before a zone could span cameras. */
function legacyDatabase(): Database {
  const fresh = new Database(":memory:");
  fresh.exec(`
    CREATE TABLE organisation (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
      retention_days INTEGER NOT NULL DEFAULT 30, created_at TEXT NOT NULL
    );
    CREATE TABLE site (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE camera (
      id TEXT PRIMARY KEY, site_id TEXT NOT NULL, name TEXT NOT NULL,
      stream_url TEXT, status TEXT NOT NULL DEFAULT 'FULL', created_at TEXT NOT NULL
    );
    CREATE TABLE zone (
      id TEXT PRIMARY KEY, camera_id TEXT NOT NULL, org_id TEXT NOT NULL,
      name TEXT NOT NULL, kind TEXT NOT NULL, geometry TEXT NOT NULL, points TEXT NOT NULL,
      watch_classes TEXT NOT NULL, log_only_classes TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'both', confirm_seconds REAL NOT NULL DEFAULT 2.0,
      severity TEXT NOT NULL DEFAULT 'WARNING', active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX zone_by_camera ON zone(camera_id, active);

    INSERT INTO organisation VALUES ('org_bsf', 'BSF', 'BSF', 30, '2026-01-01T00:00:00Z');
    INSERT INTO site VALUES ('site_a', 'org_bsf', 'BOP Attari', 'bop', '2026-01-01T00:00:00Z');
    INSERT INTO camera VALUES ('cam_1', 'site_a', 'BOP-01', NULL, 'FULL', '2026-01-01T00:00:00Z');

    INSERT INTO zone VALUES (
      'zone_old', 'cam_1', 'org_bsf', 'Fence line north', 'fence_line',
      'line', '[[0.05,0.62],[0.95,0.56]]',
      '["person","vehicle"]', '["cattle","dog"]',
      'both', 4.0, 'CRITICAL', 1, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'
    );
  `);
  return fresh;
}

function migrate(fresh: Database) {
  migrateBefore(fresh);
  fresh.exec(SCHEMA);
  migrateAfter(fresh);
}

describe("migrating off the single-camera zone", () => {
  test("the zone survives with its identity intact", () => {
    db = legacyDatabase();
    migrate(db);

    const zone = db.query("SELECT * FROM zone WHERE id = 'zone_old'").get() as any;
    expect(zone.name).toBe("Fence line north");
    expect(zone.kind).toBe("fence_line");
    expect(zone.site_id).toBe("site_a");
    expect(zone.active).toBe(1);
  });

  test("its camera, shape and patience move to the binding", () => {
    db = legacyDatabase();
    migrate(db);

    const binding = db.query("SELECT * FROM zone_camera WHERE zone_id = 'zone_old'").get() as any;
    expect(binding.camera_id).toBe("cam_1");
    expect(JSON.parse(binding.points)).toEqual([[0.05, 0.62], [0.95, 0.56]]);
    expect(binding.confirm_seconds).toBe(4);
    expect(binding.direction).toBe("both");
    // It really was positioned before, so it must not be marked a placeholder.
    expect(binding.placed).toBe(1);
  });

  test("the two class lists become ordered targets, watched ones first", () => {
    db = legacyDatabase();
    migrate(db);

    const targets = db
      .query("SELECT * FROM zone_target WHERE zone_id = 'zone_old' ORDER BY priority")
      .all() as any[];

    expect(targets.map((t) => t.class)).toEqual(["person", "vehicle", "cattle", "dog"]);
    expect(targets.map((t) => t.priority)).toEqual([1, 2, 3, 4]);
  });

  test("watched classes keep the zone's severity and stay alertable", () => {
    db = legacyDatabase();
    migrate(db);

    const person = db
      .query("SELECT * FROM zone_target WHERE zone_id = 'zone_old' AND class = 'person'")
      .get() as any;
    expect(person.severity).toBe("CRITICAL");
    expect(person.action).toBe("alert");
    expect(person.camera_id).toBeNull(); // zone policy, not a camera exception
  });

  test("animal suppression is preserved rather than quietly dropped", () => {
    db = legacyDatabase();
    migrate(db);

    const cattle = db
      .query("SELECT * FROM zone_target WHERE zone_id = 'zone_old' AND class = 'cattle'")
      .get() as any;
    expect(cattle.action).toBe("log_only");
    expect(cattle.severity).toBe("INFO");
  });

  test("the legacy table is gone afterwards", () => {
    db = legacyDatabase();
    migrate(db);

    const leftover = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='zone_legacy'")
      .get();
    expect(leftover).toBeNull();
  });

  test("running it again on an already-migrated database does nothing", () => {
    db = legacyDatabase();
    migrate(db);
    const before = db.query("SELECT COUNT(*) AS n FROM zone_target").get() as any;

    // Second boot: the schema and both halves run again, as they would.
    migrate(db);

    const after = db.query("SELECT COUNT(*) AS n FROM zone_target").get() as any;
    expect(after.n).toBe(before.n);
    expect((db.query("SELECT COUNT(*) AS n FROM zone").get() as any).n).toBe(1);
  });

  test("a fresh database needs no migration at all", () => {
    db = new Database(":memory:");
    expect(migrateBefore(db)).toBe(false);
    db.exec(SCHEMA);
    migrateAfter(db);

    expect((db.query("SELECT COUNT(*) AS n FROM zone").get() as any).n).toBe(0);
  });

  test("a zone whose camera has since been deleted is skipped, not crashed on", () => {
    db = legacyDatabase();
    db.exec("DELETE FROM camera WHERE id = 'cam_1'");
    migrate(db);

    expect((db.query("SELECT COUNT(*) AS n FROM zone").get() as any).n).toBe(0);
  });
});

describe("one camera, one zone", () => {
  /**
   * A database already on the new shape, but with a camera in two zones --
   * which is what every running post looked like before this rule, the seeded
   * data included.
   *
   * The failure this guards against is not a wrong answer, it is a dead node:
   * `schema.sql` is applied whole on every boot, its CREATE UNIQUE INDEX
   * throws on existing duplicates, and it throws at module-import time.
   */
  function doubleBoundDatabase(): Database {
    const fresh = new Database(":memory:");
    fresh.exec(SCHEMA);
    const at = "2026-09-01T00:00:00.000Z";
    fresh.exec(`
      INSERT INTO organisation (id, name, code, created_at)
        VALUES ('org', 'Org', 'ORG', '${at}');
      INSERT INTO site (id, org_id, name, kind, created_at)
        VALUES ('site', 'org', 'Site', 'bop', '${at}');
      INSERT INTO camera (id, site_id, name, created_at)
        VALUES ('cam_1', 'site', 'Cam 1', '${at}');
      INSERT INTO zone (id, org_id, site_id, name, kind, active, created_at, updated_at)
        VALUES ('zone_a', 'org', 'site', 'A', 'fence_line', 1, '${at}', '${at}'),
               ('zone_b', 'org', 'site', 'B', 'fence_line', 1, '${at}', '${at}');
    `);
    // Straight INSERTs would hit the index this migration exists to satisfy,
    // so the duplicate is created with it dropped -- exactly the state an
    // older database is already in on disk.
    fresh.exec("DROP INDEX IF EXISTS zone_camera_one_zone");
    fresh.exec(`
      INSERT INTO zone_camera
        (id, zone_id, camera_id, geometry, points, placed, active, created_at, updated_at)
      VALUES
        ('zc_undrawn', 'zone_a', 'cam_1', 'line', '[[0,0.5],[1,0.5]]', 0, 1, '${at}', '${at}'),
        ('zc_drawn',   'zone_b', 'cam_1', 'line', '[[0,0.7],[1,0.7]]', 1, 1, '${at}', '${at}');
    `);
    return fresh;
  }

  test("a database that already violates the rule still boots", () => {
    db = doubleBoundDatabase();
    expect(() => migrate(db!)).not.toThrow();

    const live = db
      .query("SELECT id FROM zone_camera WHERE camera_id = 'cam_1' AND active = 1")
      .all() as Array<{ id: string }>;
    expect(live).toHaveLength(1);
  });

  test("the binding somebody actually DREW is the one that survives", () => {
    db = doubleBoundDatabase();
    migrate(db);

    const live = db
      .query("SELECT id FROM zone_camera WHERE camera_id = 'cam_1' AND active = 1")
      .get() as { id: string };
    expect(live.id).toBe("zc_drawn");
  });

  test("the loser is retired, not deleted -- past events still point at it", () => {
    db = doubleBoundDatabase();
    migrate(db);

    const loser = db
      .query("SELECT active FROM zone_camera WHERE id = 'zc_undrawn'")
      .get() as { active: number };
    expect(loser.active).toBe(0);
  });

  test("running it twice changes nothing the second time", () => {
    db = doubleBoundDatabase();
    migrate(db);
    const first = db.query("SELECT id, active FROM zone_camera ORDER BY id").all();
    migrate(db);
    expect(db.query("SELECT id, active FROM zone_camera ORDER BY id").all()).toEqual(first);
  });

  test("a camera in exactly one zone is left alone", () => {
    db = new Database(":memory:");
    db.exec(SCHEMA);
    expect(() => migrate(db!)).not.toThrow();
  });
});
