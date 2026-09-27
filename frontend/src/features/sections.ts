/**
 * Section selection, kept free of component imports so it can be reasoned
 * about -- and tested -- without dragging in every screen.
 *
 * These two functions are the whole of the multi-deployment thesis: what a
 * client runs, and what a role may touch. If either grows a force-specific
 * branch, the "one program, many configuration files" claim is gone.
 */
import type { Role } from "@/lib/types";

export type SectionGroup =
  | "Operations"
  | "Services"
  | "Investigate"
  | "Configure";

/**
 * Reading order, and it is the order of a shift.
 *
 * Operations is what is happening and what needs a decision. Services is one
 * page per detection capability -- the same list, in the same order, as the
 * vision service's modules. Investigate is looking backwards. Configure is
 * changing how the system behaves, and is the only group a plain operator
 * cannot fully reach.
 */
export const GROUP_ORDER: SectionGroup[] = [
  "Operations",
  "Services",
  "Investigate",
  "Configure",
];

/** The half of a section that carries no React. */
export interface SectionMeta {
  id: string;
  group: SectionGroup;
  minRole: Role;
  defaultEnabled?: boolean;
  /**
   * Pinned to the bottom of the sidebar instead of listed in its group.
   *
   * A section, not a special case: it still declares a path, a role and an
   * element, still goes through `selectEnabled` and `canUse`, and is still the
   * single place the router learns the route exists. Only where the LINK is
   * drawn changes -- which is what stops a hand-written footer link drifting
   * from the page it points at. One did: the footer had a Settings button
   * pointing at `/profile`, a path with no route anywhere in the app.
   */
  footer?: boolean;
}

const RANK: Record<Role, number> = { operator: 0, supervisor: 1, admin: 2 };

/** What this deployment runs: registry default, overridden by client.json. */
export function selectEnabled<T extends SectionMeta>(
  sections: T[],
  clientSections: Record<string, boolean>,
): T[] {
  return sections.filter((section) => clientSections[section.id] ?? section.defaultEnabled ?? true);
}

/** The node enforces the same boundary with a 403; this refuses earlier. */
export const canUse = (section: SectionMeta, role: Role) => RANK[role] >= RANK[section.minRole];
