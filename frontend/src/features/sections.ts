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
  | "Situation"
  | "Investigate"
  | "Configure"
  | "Platform"
  | "Dev";

export const GROUP_ORDER: SectionGroup[] = [
  "Operations",
  "Situation",
  "Investigate",
  "Configure",
  "Platform",
  "Dev",
];

/** The half of a section that carries no React. */
export interface SectionMeta {
  id: string;
  group: SectionGroup;
  minRole: Role;
  defaultEnabled?: boolean;
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
