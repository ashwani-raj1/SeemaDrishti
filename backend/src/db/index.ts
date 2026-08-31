import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One local SQLite file. No hosted database, no external service -- a post
 * with no connectivity runs the complete feature set on this alone.
 */

const DB_PATH = process.env.IBVAP_DB ?? join(import.meta.dir, "..", "..", "ibvap.db");

export const db = new Database(DB_PATH, { create: true });

db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));

export type Row = Record<string, any>;

export function all<T = Row>(sql: string, params: Row = {}): T[] {
  return db.query(sql).all(params) as T[];
}

export function one<T = Row>(sql: string, params: Row = {}): T | null {
  return (db.query(sql).get(params) as T) ?? null;
}

export function run(sql: string, params: Row = {}): void {
  db.query(sql).run(params);
}

/** bun:sqlite has no boolean type; columns round-trip as 0/1. */
export const bool = (v: unknown): boolean => v === 1 || v === true;
export const int = (v: boolean): number => (v ? 1 : 0);

export function transact<T>(fn: () => T): T {
  return db.transaction(fn)();
}
