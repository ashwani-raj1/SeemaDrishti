import { Link } from "react-router-dom";
import { CctvIcon, LayersIcon, SparklesIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SeverityBadge, CameraStatusPill } from "@/components/ibvap/badges";
import { clockTime, dateTime, humanise, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  Camera, IbvapEvent, Incident, IncidentCamera, Zone,
} from "@/lib/types";

/**
 * The context column of the incident page.
 *
 * Every row here is read from the record. Where the design asked for something
 * this system does not measure -- a subject's speed, a behaviour
 * classification -- the row says "Not measured yet" rather than being dropped
 * or, worse, filled in. Section 7 of vision-service/CLAUDE.md: never state a figure that
 * was not measured on real hardware. A visible gap is a to-do; an invented
 * number is a lie that survives into a slide.
 */

/** One label/value row. `muted` is for the not-measured case. */
function Row({
  label,
  value,
  mono,
  muted,
  title,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1" title={title}>
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-right text-xs",
          mono && "font-mono",
          muted && "italic text-muted-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** What this system does not measure, said in one place so it reads the same. */
const NOT_MEASURED = (
  <span title="No calibration exists for this. Section 7: never quote a figure that was not measured.">
    Not measured yet
  </span>
);

// ── the incident itself ──────────────────────────────────────────────────

export function IncidentDetails({
  incident,
  event,
  camera,
  zoneName,
}: {
  incident: Incident;
  /** The event that best describes it -- the first alerting one, else the first. */
  event: IbvapEvent | null;
  camera: IncidentCamera | null;
  zoneName?: string | null;
}) {
  return (
    <Card className="gap-0 p-4">
      <CardTitle className="mb-3 text-sm font-semibold">Incident details</CardTitle>
      <dl className="divide-y">
        <Row
          label="Incident"
          mono
          value={incident.number != null ? `#${incident.number}` : incident.id}
          title={incident.id}
        />
        <Row
          label="Type"
          value={
            event?.class
              ? `${humanise(event.class)}${event.direction ? ` — ${event.direction}` : ""}`
              : humanise(incident.kind ?? "—")
          }
        />
        <Row label="Status" value={<Badge variant="outline" className="h-5">{incident.status}</Badge>} />
        <Row label="Priority" value={<SeverityBadge severity={incident.severity} />} />
        <Row
          label="Camera"
          value={
            camera ? (
              camera.removed ? (
                <span className="text-muted-foreground">removed since</span>
              ) : (
                <Link to={`/cameras/${camera.cameraId}`} className="underline underline-offset-2">
                  {camera.cameraName}
                </Link>
              )
            ) : (
              "—"
            )
          }
        />
        <Row
          label="Zone"
          value={
            incident.zoneId && zoneName ? (
              <Link to="/zones" className="underline underline-offset-2">
                {zoneName}
              </Link>
            ) : (
              "—"
            )
          }
        />
        <Row label="Opened" mono value={dateTime(incident.openedAt)} />
        <Row label="Last event" mono value={clockTime(incident.lastEventAt)} />
        <Row label="Events" mono value={String(incident.eventCount)} />
        {event?.confidence != null && (
          <Row label="Confidence" mono value={percent(event.confidence)} />
        )}
        {event?.rule && <Row label="Rule" mono value={event.rule} />}
        {event && (
          <Row label="Source" mono value={`${event.source.type} · ${event.source.id}`} />
        )}
        {/* The difference between "we recorded it" and "we asked for a human".
            An incident exists for every event, so this is not a severity. */}
        <Row
          label="Raised an alert"
          value={
            incident.alertable ? (
              <span className="font-medium text-destructive">yes</span>
            ) : (
              <span className="text-muted-foreground">no — recorded only</span>
            )
          }
        />
      </dl>
    </Card>
  );
}

// ── the zone it happened in ──────────────────────────────────────────────

export function ZoneInformation({ zone }: { zone: Zone | null }) {
  if (!zone) return null;

  return (
    <Card className="gap-0 p-4">
      <CardHeader className="mb-3 flex-row items-center justify-between gap-2 space-y-0 p-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <LayersIcon className="size-4 text-muted-foreground" />
          {zone.name}
        </CardTitle>
        <Button asChild size="sm" variant="outline" className="h-7 text-xs">
          <Link to="/zones">View zone</Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <dl className="divide-y">
          <Row label="Kind" value={humanise(zone.kind)} />
          <Row label="Shape" value={zone.geometry} mono />
          <Row
            label="Alerts on"
            value={zone.watchClasses.length ? zone.watchClasses.join(", ") : "—"}
          />
          {zone.logOnlyClasses.length > 0 && (
            <Row
              label="Logged only"
              value={zone.logOnlyClasses.join(", ")}
              title="Written to the record and never raised — the animal filter."
            />
          )}
          <Row label="Direction" value={zone.direction} />
          {/* The mockup called this "dwell time". It is `confirm_seconds`: how
              long a crossing must hold before it counts. Named for what it
              does, because it is half of a two-clock rule and the console has
              already cost somebody a day by being vague about it. */}
          <Row
            label="Must hold for"
            mono
            value={`${zone.confirmSeconds}s`}
            title="Plus a frame count — a crossing must satisfy both."
          />
          {zone.provisional && (
            <Row
              label="Shape"
              value={<span className="text-amber-600 dark:text-amber-500">never drawn</span>}
              title="Judged against the stock placeholder. Crossings are recorded and never alerted."
            />
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

// ── the camera it came from ──────────────────────────────────────────────

export function CameraInformation({
  camera,
  hub,
}: {
  camera: IncidentCamera | null;
  /** Live facts from the media hub: resolution, codec, whether it is serving. */
  hub?: { width?: number | null; height?: number | null; codec?: string | null; ready?: boolean };
}) {
  if (!camera) return null;

  return (
    <Card className="gap-0 p-4">
      <CardHeader className="mb-3 flex-row items-center justify-between gap-2 space-y-0 p-0">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{camera.cameraName ?? camera.cameraId}</span>
        </CardTitle>
        {!camera.removed && (
          <Button asChild size="sm" variant="outline" className="h-7 text-xs">
            <Link to={`/cameras/${camera.cameraId}`}>View camera</Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <dl className="divide-y">
          <Row label="Id" mono value={camera.cameraId} />
          <Row
            label="Resolution"
            mono
            value={hub?.width && hub?.height ? `${hub.width}×${hub.height}` : "—"}
          />
          <Row label="Codec" mono value={hub?.codec ?? "—"} />
          <Row
            label="Status"
            value={
              camera.removed ? (
                <span className="text-muted-foreground">removed</span>
              ) : camera.status ? (
                <CameraStatusPill status={camera.status} />
              ) : (
                "—"
              )
            }
          />
          {/* `enabled` and `status` are different facts and the schema keeps
              them apart on purpose: "we cannot see" versus "we chose to stop
              looking". */}
          {!camera.enabled && !camera.removed && (
            <Row
              label="In service"
              value={<span className="text-amber-600 dark:text-amber-500">taken out</span>}
            />
          )}
          <Row
            label="Serving now"
            value={hub?.ready === undefined ? "—" : hub.ready ? "yes" : "no feed"}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

// ── what the detector concluded ──────────────────────────────────────────

export function DetectorAnalysis({ event }: { event: IbvapEvent | null }) {
  if (!event) return null;
  const evidence = event.evidence ?? {};

  return (
    <Card className="gap-0 p-4">
      <CardTitle className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <SparklesIcon className="size-4 text-muted-foreground" />
        Detector analysis
      </CardTitle>
      <dl className="divide-y">
        <Row label="Object class" value={event.class ? humanise(event.class) : "—"} />
        <Row label="Confidence" mono value={percent(event.confidence)} />
        <Row label="Direction" value={event.direction ?? "—"} />
        <Row
          label="Track"
          mono
          value={evidence.trackRef ?? "—"}
          title="A tracker id, not an identity. There is no re-identification in this build."
        />
        {/* Both halves of the confirm rule, side by side. Quoting one without
            the other hides which of the two actually held the crossing back --
            and a plausible-looking confirmSeconds that nothing can satisfy is
            exactly how a fence records nothing for a day. */}
        <Row
          label="Held / required"
          mono
          value={
            evidence.confirmSeconds !== undefined
              ? `${evidence.heldSeconds ?? "?"}s / ${evidence.confirmSeconds}s`
              : "—"
          }
        />
        <Row
          label="Frames"
          mono
          value={
            evidence.confirmFrames !== undefined
              ? `${evidence.heldFrames ?? "?"} / ${evidence.confirmFrames}`
              : "—"
          }
        />
        <Row label="Judged by" mono value={evidence.detector ?? "—"} />

        {/* Asked for by the design, measured by nothing. Speed needs a
            per-camera homography nobody has surveyed; behaviour needs a
            classifier that does not exist. Left visible as honest gaps. */}
        <Row label="Speed (est.)" value={NOT_MEASURED} muted />
        <Row label="Behaviour" value={NOT_MEASURED} muted />
      </dl>
    </Card>
  );
}

// ── what else was watching ───────────────────────────────────────────────

export function AlsoWatching({
  cameras,
}: {
  cameras: Array<{
    cameraId: string;
    cameraName: string;
    cameraStatus: string;
    enabled: boolean;
    isSource: boolean;
  }>;
}) {
  const others = cameras.filter((camera) => !camera.isSource);

  return (
    <Card className="gap-0 p-4">
      <CardTitle className="mb-3 text-sm font-semibold">
        Also watching ({others.length})
      </CardTitle>
      {others.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {/* "Nothing else could have seen this" is itself worth knowing -- it
              is the difference between no corroboration and no coverage. */}
          No other camera covers this zone, so there is nothing to corroborate
          against.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {others.map((camera) => (
            <Link
              key={camera.cameraId}
              to={`/cameras/${camera.cameraId}`}
              className="flex items-center gap-2 rounded-md border p-2 text-xs transition-colors hover:bg-accent/50"
            >
              <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{camera.cameraName}</span>
              {!camera.enabled && (
                <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-500">
                  out of service
                </span>
              )}
              <CameraStatusPill status={camera.cameraStatus as never} />
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── other incidents on the same ground ───────────────────────────────────

export function RelatedIncidents({
  incidents,
  windowSeconds,
}: {
  incidents: Incident[];
  windowSeconds?: number;
}) {
  return (
    <Card className="gap-0 p-4">
      <CardHeader className="mb-3 flex-row items-center justify-between gap-2 space-y-0 p-0">
        <CardTitle className="text-sm font-semibold">
          Related incidents ({incidents.length})
        </CardTitle>
        {windowSeconds && (
          <span className="text-[11px] text-muted-foreground">
            ±{Math.round(windowSeconds / 60)} min
          </span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {incidents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing else happened on this zone around the same time.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {incidents.map((incident) => (
              <Link
                key={incident.id}
                to={`/incidents/${incident.id}`}
                className="flex items-center gap-2 rounded-md p-1.5 text-xs transition-colors hover:bg-accent/50"
              >
                <SeverityBadge severity={incident.severity} />
                <span className="min-w-0 flex-1 truncate">{incident.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {incident.number != null ? `#${incident.number}` : ""}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {clockTime(incident.lastEventAt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export { Row as IncidentRow };
export type { Camera };
