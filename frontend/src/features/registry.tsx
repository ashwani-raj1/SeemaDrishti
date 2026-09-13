/**
 * The one place a section is declared (#39).
 *
 * The sidebar and the router both read this array, so they cannot drift apart,
 * and turning a section off for a deployment is one key in client.json rather
 * than a conditional somewhere in a component. There is no force-specific code
 * anywhere below this file -- that is the whole "one program, many
 * configuration files" thesis, and it only holds if it is never special-cased.
 *
 * THE SERVICES GROUP MIRRORS THE DETECTOR. One page per vision module, named
 * the same, in the same order as `ibvap/modules/`. That is not decoration: it
 * means an operator asking "what can this system do" reads the same list a
 * developer reads, and adding a module adds exactly one page here. Camera
 * health joins them because "what can we see at all" is the precondition for
 * every other service, and it is the one capability whose failure is silent.
 *
 * NOTHING IN THIS FILE IS A PLACEHOLDER. A nav entry that opens an explanation
 * of an endpoint nobody wrote is clutter an operator has to learn to skip, and
 * a jury reads it as a half-built product. Sections arrive when they work.
 */
import type { LucideIcon } from "lucide-react";
import {
  CarFrontIcon, CctvIcon, FileClockIcon, HistoryIcon, LayersIcon,
  LayoutDashboardIcon, MapIcon, ScanEyeIcon, SirenIcon, UsersIcon,
} from "lucide-react";
import { canUse, GROUP_ORDER, selectEnabled, type SectionGroup, type SectionMeta } from "./sections";

import { DashboardScreen } from "./dashboard/screen";
import { IncidentsScreen } from "./incidents/screen";
import { IncidentPage } from "./incidents/page";
import { HistoryScreen } from "./history/screen";
import { AuditScreen } from "./audit/screen";
import { ZonesScreen } from "./zones/screen";
import { CamerasScreen } from "./cameras/screen";
import { CameraPage } from "./cameras/page";
import { SectorMapScreen } from "./map/screen";
import { WatchlistScreen } from "./watchlist/screen";
import { FenceScreen } from "./services/fence";
import { AnprScreen } from "./services/anpr";
import { PeopleScreen } from "./services/people";
import { CameraHealthScreen } from "./services/camera-health";

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
  element: React.ReactNode;
  /** Addressed pages beneath this section, e.g. /incidents/:incidentId. */
  details?: SectionDetail[];
}

export const SECTIONS: Section[] = [
  // ------------------------------------------------------------- Operations
  {
    id: "dashboard",
    group: "Operations",
    label: "Dashboard",
    icon: LayoutDashboardIcon,
    path: "/dashboard",
    minRole: "operator",
    element: <DashboardScreen />,
  },
  {
    id: "incidents",
    group: "Operations",
    label: "Incidents",
    icon: SirenIcon,
    path: "/incidents",
    minRole: "operator",
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
    element: <SectorMapScreen />,
  },

  // --------------------------------------------------------------- Services
  {
    id: "fence",
    group: "Services",
    label: "Virtual fence",
    icon: LayersIcon,
    path: "/services/fence",
    minRole: "operator",
    element: <FenceScreen />,
  },
  {
    id: "anpr",
    group: "Services",
    label: "Number plates",
    icon: CarFrontIcon,
    path: "/services/anpr",
    minRole: "operator",
    element: <AnprScreen />,
  },
  {
    id: "people",
    group: "Services",
    label: "People",
    icon: UsersIcon,
    path: "/services/people",
    minRole: "operator",
    element: <PeopleScreen />,
  },
  {
    id: "camera-health",
    group: "Services",
    label: "Camera health",
    icon: ScanEyeIcon,
    path: "/services/health",
    minRole: "operator",
    element: <CameraHealthScreen />,
  },

  // ------------------------------------------------------------ Investigate
  {
    id: "history",
    group: "Investigate",
    label: "History",
    icon: HistoryIcon,
    path: "/history",
    minRole: "supervisor",
    element: <HistoryScreen />,
  },
  {
    id: "audit",
    group: "Investigate",
    label: "Audit trail",
    icon: FileClockIcon,
    path: "/audit",
    minRole: "operator",
    element: <AuditScreen />,
  },

  // -------------------------------------------------------------- Configure
  {
    id: "cameras",
    group: "Configure",
    label: "Cameras",
    icon: CctvIcon,
    path: "/cameras",
    minRole: "operator",
    element: <CamerasScreen />,
    details: [{ path: "/cameras/:cameraId", element: <CameraPage /> }],
  },
  {
    id: "zones",
    group: "Configure",
    label: "Zones",
    icon: LayersIcon,
    path: "/zones",
    minRole: "supervisor",
    element: <ZonesScreen />,
  },
  {
    id: "watchlist",
    group: "Configure",
    label: "Plate watchlist",
    icon: CarFrontIcon,
    path: "/watchlist",
    minRole: "supervisor",
    element: <WatchlistScreen />,
  },
];

export const DEFAULT_PATH = "/dashboard";

/** What this deployment runs: registry default, overridden by client.json. */
export const enabledSections = (clientSections: Record<string, boolean>): Section[] =>
  selectEnabled(SECTIONS, clientSections);
