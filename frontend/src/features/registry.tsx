/**
 * The one place a section is declared (#39).
 *
 * The sidebar and the router both read this array, so they cannot drift apart,
 * and turning a section off for a deployment is one key in client.json rather
 * than a conditional somewhere in a component. There is no force-specific code
 * anywhere below this file -- that is the whole "one program, many
 * configuration files" thesis, and it only holds if it is never special-cased.
 */
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon, CarFrontIcon, CctvIcon, ClipboardListIcon, MapIcon,
  EyeIcon, FileClockIcon, GaugeIcon, HistoryIcon, LayersIcon, PlugIcon,
  RefreshCwIcon, ScrollTextIcon, ShieldCheckIcon, SirenIcon, SlidersHorizontalIcon,
  UsersIcon,
} from "lucide-react";
import type { Role } from "@/lib/types";
import { NotWired } from "@/components/ibvap/states";
import { canUse, GROUP_ORDER, selectEnabled, type SectionGroup, type SectionMeta } from "./sections";

import { IncidentsScreen } from "./incidents/screen";
import { IncidentPage } from "./incidents/page";
import { LiveCamerasScreen } from "./live/screen";
import { StatusBoardScreen } from "./status/screen";
import { HistoryScreen } from "./history/screen";
import { EventLogScreen } from "./events/screen";
import { AuditScreen } from "./audit/screen";
import { ZonesScreen } from "./zones/screen";
import { SiteProfileScreen } from "./profile/screen";
import { CamerasScreen } from "./cameras/screen";
import { CameraPage } from "./cameras/page";
import { SimulatorScreen } from "./simulator/screen";
import { SectorMapScreen } from "./map/screen";

export type { SectionGroup };
export { GROUP_ORDER, canUse };

/**
 * A page reachable under a section but absent from the sidebar.
 *
 * Detail pages are addressed, not navigated to -- you arrive by clicking a row
 * or by opening a link somebody sent you. Listing them in the nav would be
 * meaningless (which incident?), but they still have to be declared here so
 * the router and the registry cannot drift apart.
 */
export interface SectionDetail {
  path: string;
  element: React.ReactNode;
}

export interface Section extends SectionMeta {
  label: string;
  icon: LucideIcon;
  path: string;
  /** False means the design defines it but no endpoint serves it yet. */
  backed: boolean;
  element: React.ReactNode;
  /** Addressed pages beneath this section, e.g. /incidents/:incidentId. */
  details?: SectionDetail[];
}

export const SECTIONS: Section[] = [
  // ------------------------------------------------------------- Operations
  {
    id: "incidents",
    group: "Operations",
    label: "Incidents",
    icon: SirenIcon,
    path: "/incidents",
    minRole: "operator",
    backed: true,
    element: <IncidentsScreen />,
    details: [{ path: "/incidents/:incidentId", element: <IncidentPage /> }],
  },
  {
    id: "map",
    group: "Operations",
    label: "Sector map",
    icon: MapIcon,
    path: "/map",
    minRole: "operator",
    backed: true,
    element: <SectorMapScreen />,
  },
  {
    id: "live",
    group: "Operations",
    label: "Live cameras",
    icon: CctvIcon,
    path: "/live",
    minRole: "operator",
    backed: true,
    element: <LiveCamerasScreen />,
  },
  {
    id: "second-look",
    group: "Operations",
    label: "Second look",
    icon: EyeIcon,
    path: "/second-look",
    minRole: "operator",
    backed: false,
    element: (
      <NotWired
        label="Second look"
        item="#15 — the review queue for uncertain and suppressed detections, which is what makes the animal filter's suppression defensible"
        waitingOn="GET /api/second-look"
      />
    ),
  },

  // -------------------------------------------------------------- Situation
  {
    id: "status",
    group: "Situation",
    label: "Status board",
    icon: GaugeIcon,
    path: "/status",
    minRole: "operator",
    backed: true,
    element: <StatusBoardScreen />,
  },
  {
    id: "handover",
    group: "Situation",
    label: "Shift handover",
    icon: ClipboardListIcon,
    path: "/handover",
    minRole: "operator",
    backed: false,
    element: (
      <NotWired
        label="Shift handover"
        item="#23 — the end-of-shift digest: what fired, what was acknowledged, what is still open, which cameras degraded"
        waitingOn="GET /api/handover"
      />
    ),
  },

  // ------------------------------------------------------------ Investigate
  {
    id: "history",
    group: "Investigate",
    label: "History search",
    icon: HistoryIcon,
    path: "/history",
    minRole: "supervisor",
    backed: true,
    element: <HistoryScreen />,
  },
  {
    id: "events",
    group: "Investigate",
    label: "Event log",
    icon: ScrollTextIcon,
    path: "/events",
    minRole: "operator",
    backed: true,
    element: <EventLogScreen />,
  },
  {
    id: "audit",
    group: "Investigate",
    label: "Audit trail",
    icon: FileClockIcon,
    path: "/audit",
    minRole: "operator",
    backed: true,
    element: <AuditScreen />,
  },

  // -------------------------------------------------------------- Configure
  {
    id: "zones",
    group: "Configure",
    label: "Zones",
    icon: LayersIcon,
    path: "/zones",
    minRole: "supervisor",
    backed: true,
    element: <ZonesScreen />,
  },
  {
    id: "profile",
    group: "Configure",
    label: "Site profile",
    icon: SlidersHorizontalIcon,
    path: "/profile",
    minRole: "supervisor",
    backed: true,
    element: <SiteProfileScreen />,
  },
  {
    id: "cameras",
    group: "Configure",
    label: "Cameras",
    icon: CctvIcon,
    path: "/cameras",
    minRole: "operator",
    backed: true,
    element: <CamerasScreen />,
    details: [{ path: "/cameras/:cameraId", element: <CameraPage /> }],
  },
  {
    id: "watchlist",
    group: "Configure",
    label: "Plate watchlist",
    icon: CarFrontIcon,
    path: "/watchlist",
    minRole: "supervisor",
    backed: false,
    element: (
      <NotWired
        label="Plate watchlist"
        item="#36 — checking a read plate against a flagged-vehicle list, which runs against a clearly labelled mock registry because no real one is available"
        waitingOn="GET /api/watchlist"
      />
    ),
  },

  // --------------------------------------------------------------- Platform
  {
    id: "users",
    group: "Platform",
    label: "Users & roles",
    icon: UsersIcon,
    path: "/users",
    minRole: "admin",
    backed: false,
    element: (
      <NotWired
        label="Users & roles"
        item="#34 — operator sees live incidents, supervisor can additionally search history, and every search is itself recorded"
        waitingOn="POST /api/users"
      />
    ),
  },
  {
    id: "org",
    group: "Platform",
    label: "Organisation",
    icon: ShieldCheckIcon,
    path: "/org",
    minRole: "admin",
    backed: false,
    element: (
      <NotWired
        label="Organisation"
        item="#37 and #42 — per-organisation isolation and a retention window that is a running job, not a policy document"
        waitingOn="PATCH /api/organisation"
      />
    ),
  },
  {
    id: "integrations",
    group: "Platform",
    label: "Integrations",
    icon: PlugIcon,
    path: "/integrations",
    minRole: "admin",
    backed: false,
    element: (
      <NotWired
        label="Integrations"
        item="#29 — taking data in, sending it out and syncing to headquarters are one mechanism pointed in three directions. The ingress half already exists at /hooks/ingress/*; this is the screen that manages it"
        waitingOn="GET /api/adapters"
      />
    ),
  },
  {
    id: "sync",
    group: "Platform",
    label: "Sync & queue",
    icon: RefreshCwIcon,
    path: "/sync",
    minRole: "admin",
    backed: false,
    element: (
      <NotWired
        label="Sync & queue"
        item="#26 and #40 — events pile up locally when the link drops and replay by sequence number when it returns, with the originating site winning any disagreement"
        waitingOn="GET /api/sync/status"
      />
    ),
  },

  // -------------------------------------------------------------------- Dev
  {
    id: "simulator",
    group: "Dev",
    label: "Simulator",
    icon: ActivityIcon,
    path: "/simulator",
    minRole: "operator",
    backed: true,
    element: <SimulatorScreen />,
  },
];

export const DEFAULT_PATH = "/incidents";

/** What this deployment runs: registry default, overridden by client.json. */
export const enabledSections = (clientSections: Record<string, boolean>): Section[] =>
  selectEnabled(SECTIONS, clientSections);
