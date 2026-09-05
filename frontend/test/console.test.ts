/**
 * The load-bearing logic behind the console, checked without a browser.
 *
 * Not a component suite -- these are the three things that would silently
 * break the product if they were wrong: which sections a deployment runs,
 * which a role may open, and the order a tired operator works in.
 */
import { describe, expect, test } from "bun:test";
import { FALLBACK_CONFIG, mergeConfig } from "../src/client/config";
import { canUse, selectEnabled, type SectionMeta } from "../src/features/sections";
import { rankIncidents } from "../src/features/incidents/use-incidents";
import { humanise, percent, relative } from "../src/lib/format";
import type { Incident } from "../src/lib/types";

const section = (id: string, extra: Partial<SectionMeta> = {}): SectionMeta => ({
  id,
  group: "Operations",
  minRole: "operator",
  ...extra,
});

describe("per-client configuration", () => {
  test("a client file overrides only what it names", () => {
    const merged = mergeConfig(FALLBACK_CONFIG, {
      brand: { name: "Coastal Watch", short: "CW" },
      sections: { simulator: false },
    });

    expect(merged.brand.name).toBe("Coastal Watch");
    // Untouched keys survive, or a partial file would blank the deployment.
    expect(merged.brand.tagline).toBe(FALLBACK_CONFIG.brand.tagline);
    expect(merged.apiBase).toBe(FALLBACK_CONFIG.apiBase);
    expect(merged.defaults.pollMs).toBe(FALLBACK_CONFIG.defaults.pollMs);
    expect(merged.sections.simulator).toBe(false);
  });
});

describe("section selection", () => {
  const sections = [
    section("incidents"),
    section("simulator"),
    section("watchlist", { defaultEnabled: false }),
  ];

  test("everything runs unless the client turns it off", () => {
    expect(selectEnabled(sections, {}).map((s) => s.id)).toEqual(["incidents", "simulator"]);
  });

  test("a client file can switch a section off", () => {
    expect(selectEnabled(sections, { simulator: false }).map((s) => s.id)).toEqual(["incidents"]);
  });

  test("a client file can switch a default-off section on", () => {
    expect(selectEnabled(sections, { watchlist: true }).map((s) => s.id)).toContain("watchlist");
  });
});

describe("role boundary", () => {
  test("roles are a ladder, not a set of unrelated flags", () => {
    const history = section("history", { minRole: "supervisor" });
    expect(canUse(history, "operator")).toBe(false);
    expect(canUse(history, "supervisor")).toBe(true);
    // An admin must not be locked out of what a supervisor can do.
    expect(canUse(history, "admin")).toBe(true);
  });
});

describe("incident ranking", () => {
  const at = (iso: string, severity: Incident["severity"], id: string): Incident => ({
    id,
    title: id,
    severity,
    status: "OPEN",
    cameraId: null,
    zoneId: null,
    openedAt: iso,
    lastEventAt: iso,
    eventCount: 1,
  });

  test("worst first, then most recent", () => {
    const ranked = rankIncidents([
      at("2026-01-01T02:00:00Z", "INFO", "info-new"),
      at("2026-01-01T01:00:00Z", "CRITICAL", "crit-old"),
      at("2026-01-01T03:00:00Z", "CRITICAL", "crit-new"),
      at("2026-01-01T02:30:00Z", "WARNING", "warn"),
    ]);

    expect(ranked.map((incident) => incident.id)).toEqual([
      "crit-new",
      "crit-old",
      "warn",
      "info-new",
    ]);
  });

  test("does not mutate the list handed to it", () => {
    const original = [at("2026-01-01T01:00:00Z", "INFO", "a"), at("2026-01-01T02:00:00Z", "CRITICAL", "b")];
    rankIncidents(original);
    expect(original[0]!.id).toBe("a");
  });
});

describe("formatting", () => {
  test("relative time", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(relative("2026-01-01T11:59:30Z", now)).toBe("30s ago");
    expect(relative("2026-01-01T11:30:00Z", now)).toBe("30m ago");
    expect(relative("2026-01-01T09:00:00Z", now)).toBe("3h ago");
    expect(relative("2025-12-29T12:00:00Z", now)).toBe("3d ago");
    // Clock skew between node and browser must not render "-4s ago".
    expect(relative("2026-01-01T12:00:04Z", now)).toBe("just now");
  });

  test("confidence renders as a percentage, and absence as a dash", () => {
    expect(percent(0.74)).toBe("74%");
    expect(percent(null)).toBe("--");
    expect(percent(undefined)).toBe("--");
  });

  test("class names become readable", () => {
    expect(humanise("wild_boar")).toBe("Wild boar");
    expect(humanise("fence_line")).toBe("Fence line");
  });
});
