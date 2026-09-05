/**
 * Deployment profiles — the "same program, different configuration" claim (#39).
 *
 * Each profile is data, not code. Applying one rewrites the site's zones and
 * nothing else: no branch anywhere asks which force this is. Adding ITBP or a
 * police check post means adding an entry here, not touching a component.
 *
 * Zones are applied in order against the site's existing zones, because a zone
 * is only a shape plus a label — what it *means* is exactly these fields.
 */
import type { Direction, Severity, ZoneKind } from "@/lib/types";

export interface ProfileZone {
  name: string;
  kind: ZoneKind;
  watchClasses: string[];
  logOnlyClasses: string[];
  direction: Direction | "both";
  severity: Severity;
  confirmSeconds: number;
}

export interface SiteProfile {
  id: string;
  label: string;
  force: string;
  summary: string;
  zones: ProfileZone[];
}

export const SITE_PROFILES: SiteProfile[] = [
  {
    id: "border_fence",
    label: "Border fence",
    force: "BSF · Punjab / Jammu",
    summary:
      "Fence line, farm gate and patrol road. Farmers cross daily on fixed schedules, so cattle and dogs are logged and never alerted.",
    zones: [
      {
        name: "Fence line north",
        kind: "fence_line",
        watchClasses: ["person", "vehicle", "tractor"],
        logOnlyClasses: ["cattle", "dog", "nilgai", "wild_boar"],
        direction: "both",
        severity: "CRITICAL",
        confirmSeconds: 4,
      },
      {
        name: "Farm gate",
        kind: "gate",
        watchClasses: ["person", "tractor", "vehicle"],
        logOnlyClasses: ["cattle", "dog"],
        direction: "both",
        severity: "WARNING",
        confirmSeconds: 3,
      },
      {
        name: "Patrol road verge",
        kind: "restricted_area",
        watchClasses: ["person", "vehicle"],
        logOnlyClasses: ["cattle", "dog", "nilgai"],
        direction: "both",
        severity: "INFO",
        confirmSeconds: 2,
      },
      {
        name: "Waterline",
        kind: "waterline",
        watchClasses: ["person", "boat"],
        logOnlyClasses: ["cattle"],
        direction: "inbound",
        severity: "CRITICAL",
        confirmSeconds: 3,
      },
    ],
  },
  {
    id: "naval_waterline",
    label: "Naval waterline",
    force: "Navy / Coast Guard",
    summary:
      "Jetty perimeter and waterline. Same primitives, different labels — a fence line and a jetty perimeter are the same thing wearing different names.",
    zones: [
      {
        name: "Jetty perimeter",
        kind: "perimeter",
        watchClasses: ["person", "boat", "vehicle"],
        logOnlyClasses: ["dog"],
        direction: "inbound",
        severity: "CRITICAL",
        confirmSeconds: 3,
      },
      {
        name: "Restricted quay",
        kind: "restricted_area",
        watchClasses: ["person", "vehicle"],
        logOnlyClasses: ["dog"],
        direction: "both",
        severity: "WARNING",
        confirmSeconds: 2,
      },
      {
        name: "Approach road",
        kind: "gate",
        watchClasses: ["person", "vehicle"],
        logOnlyClasses: ["dog"],
        direction: "both",
        severity: "INFO",
        confirmSeconds: 2,
      },
      {
        name: "Waterline south",
        kind: "waterline",
        watchClasses: ["person", "boat"],
        logOnlyClasses: [],
        direction: "inbound",
        severity: "CRITICAL",
        confirmSeconds: 2.5,
      },
    ],
  },
];
