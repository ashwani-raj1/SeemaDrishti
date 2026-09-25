import { tmpdir } from "node:os";
import { join } from "node:path";

// This module must be imported before application/database modules. It keeps
// ANPR/watchlist fixtures out of the operator's real local database.
export const WATCHLIST_TEST_DB = join(
  tmpdir(),
  `ibvap-watchlist-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);

process.env.IBVAP_DB = WATCHLIST_TEST_DB;
