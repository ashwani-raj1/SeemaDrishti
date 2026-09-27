import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CarFrontIcon, LayersIcon, ScanEyeIcon, SirenIcon, TriangleAlertIcon, UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageShell } from "@/components/ibvap/page-shell";
import { SeverityBadge } from "@/components/ibvap/badges";
import { LiveDot } from "@/components/ibvap/live-dot";
import { VisionStatusCard, useVisionStatus } from "@/components/ibvap/vision-status";
import { LoadingRows } from "@/components/ibvap/states";
import { api } from "@/lib/api";
import { onStream } from "@/lib/stream";
import { relative } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { SEVERITY_RANK, type Incident } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The first screen of a shift: what needs a person, and what we can see.
 *
 * DELIBERATELY SMALL. The previous dashboard was six cards and about 1500 lines
 * carrying a map, a camera wall, a filter bar and a carousel -- most of which
 * existed in full elsewhere in the app. A summary screen that duplicates every
 * other screen is not a summary, and a three-person control room reads the top
 * of this page and then goes to the section that matters.
 *
 * So it answers three questions and stops:
 *
 *   does anything need me now     open incidents, worst first
 *   can we see                    how many feeds are serving
 *   what is each service doing    one tile per capability, with a way in
 *
 * Everything else is one click away and does it properly.
 */

interface ServiceTile {
  id: string;
  label: string;
  icon: LucideIcon;
  path: string;
  /** Event kinds the node records for this service. */
  kinds: string[];
  blurb: string;
}

const SERVICES: ServiceTile[] = [
  {
    id: "fence",
    label: "Virtual fence",
    icon: LayersIcon,
    path: "/services/fence",
    kinds: ["zone_crossing"],
    blurb: "Zone and line crossings",
  },
  {
    id: "watchlist",
    label: "Plate watchlist",
    icon: CarFrontIcon,
    path: "/watchlist",
    kinds: ["plate_detection"],
    blurb: "Plate reads and watchlist hits",
  },
  {
    id: "people",
    label: "People",
    icon: UsersIcon,
    path: "/services/people",
    kinds: ["reidentification"],
    blurb: "Person tracking",
  },
  {
    id: "health",
    label: "Camera health",
    icon: ScanEyeIcon,
    path: "/services/health",
    kinds: ["camera_health"],
    blurb: "What we can see",
  },
];

export function DashboardScreen() {
  const hub = useResource(() => api.mediaCameras(), []);
  const vision = useVisionStatus();
  const [incidents, setIncidents] = useState<Incident[] | null>(null);

  const load = useCallback(async () => {
    setIncidents(await api.incidents({ limit: 100 }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Pushed, not polled. An incident that opened while somebody was looking at
  // this page has to appear on it.
  useEffect(() => {
    const offIncident = onStream("incident", () => void load());
    const offEvent = onStream("event", () => void load());
    return () => {
      offIncident();
      offEvent();
    };
  }, [load]);

  const open = useMemo(
    () =>
      (incidents ?? [])
        .filter((i) => i.status === "OPEN" || i.status === "ACKNOWLEDGED")
        .sort(
          (a, b) =>
            SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
            Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt),
        ),
    [incidents],
  );

  const critical = open.filter((i) => i.severity === "CRITICAL").length;
  const cameras = hub.data?.cameras ?? [];
  const serving = cameras.filter((camera) => camera.ready).length;
  // A camera taken out of service on purpose is not blindness — see the
  // camera health page for why those two are never merged.
  const blind = cameras.filter((c) => !c.ready && c.enabled !== false).length;
  const unseeded = cameras.filter((c) => !c.seeded).length;

  return (
    <PageShell
      title="Dashboard"
      description="What needs a decision, and what we can currently see."
      actions={<LiveDot withLabel />}
    >
      {blind > 0 && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>
            {blind} camera{blind === 1 ? "" : "s"} not sending frames
          </AlertTitle>
          <AlertDescription>
            No video is arriving from {blind === 1 ? "it" : "them"}. A feed that
            stopped looks exactly like a quiet night —{" "}
            <Link to="/services/health" className="underline">check camera health</Link>.
          </AlertDescription>
        </Alert>
      )}

      {unseeded > 0 && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>
            {unseeded} camera{unseeded === 1 ? "" : "s"} serving but unknown to the node
          </AlertTitle>
          <AlertDescription>
            Video arrives and every detection from{" "}
            {unseeded === 1 ? "it" : "them"} is rejected, so no incident can ever
            open —{" "}
            <Link to="/cameras" className="underline">add {unseeded === 1 ? "it" : "them"} on the Cameras page</Link>.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Open incidents"
          value={incidents === null ? "—" : String(open.length)}
          tone={critical > 0 ? "bad" : open.length > 0 ? "warn" : "good"}
          detail={critical > 0 ? `${critical} critical` : "nothing critical"}
          to="/incidents"
        />
        <Stat
          label="Feeds serving"
          value={hub.loading ? "—" : `${serving}/${cameras.length}`}
          tone={blind > 0 ? "bad" : "good"}
          detail={blind > 0 ? `${blind} blind` : "all cameras up"}
          to="/services/health"
        />
        <Stat
          label="Media hub"
          value={hub.data?.hub.reachable ? "up" : hub.loading ? "—" : "down"}
          tone={hub.data?.hub.reachable ? "good" : "bad"}
          detail={hub.data?.hub.reachable ? "answering" : (hub.data?.hub.error ?? "")}
          to="/services/health"
        />
        <Stat
          label="Vision service"
          value={vision.up ? "up" : vision.link === "connecting" ? "—" : "down"}
          tone={vision.up ? "good" : "bad"}
          detail={
            vision.up
              ? `${vision.status?.cameras.length ?? 0} camera(s) detecting`
              : "not reporting — overlay only, record unaffected"
          }
          to="/services/health"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium">Needs a decision</CardTitle>
            <Button asChild size="sm" variant="outline">
              <Link to="/incidents">All incidents</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {incidents === null && <LoadingRows rows={4} />}
            {incidents !== null && open.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nothing open. Everything raised has been acted on.
              </p>
            )}
            <div className="flex flex-col gap-2">
              {open.slice(0, 6).map((incident) => (
                <Link
                  key={incident.id}
                  to={`/incidents/${incident.id}`}
                  className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm hover:bg-muted/50"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <SirenIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{incident.title}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {relative(incident.lastEventAt)}
                    </span>
                    <SeverityBadge severity={incident.severity} />
                  </span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Services</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {SERVICES.map((service) => (
              <Link
                key={service.id}
                to={service.path}
                className="flex items-center gap-3 rounded-md border p-3 text-sm hover:bg-muted/50"
              >
                <service.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{service.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {service.blurb}
                  </span>
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

function Stat({
  label, value, detail, tone, to,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "good" | "warn" | "bad";
  to: string;
}) {
  return (
    <Link to={to}>
      <Card className="transition-colors hover:bg-muted/50">
        <CardContent className="flex flex-col gap-1 pt-6">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <span
            className={cn(
              "text-3xl font-semibold tabular-nums",
              tone === "bad" && "text-destructive",
              tone === "warn" && "text-amber-600 dark:text-amber-400",
            )}
          >
            {value}
          </span>
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        </CardContent>
      </Card>
    </Link>
  );
}
