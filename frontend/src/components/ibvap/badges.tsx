import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CameraStatus, Severity } from "@/lib/types";
import { humanise } from "@/lib/format";

/**
 * Three levels, not an on/off alarm (#20) -- attention has to be rationed.
 *
 * Severity is the one place raw colour is justified: INFO/WARNING/CRITICAL is
 * a fixed three-step scale that must be readable across the room, and the
 * theme's semantic tokens only carry one "destructive".
 */
const SEVERITY_STYLES: Record<Severity, string> = {
  INFO: "border-transparent bg-muted text-muted-foreground",
  WARNING: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  CRITICAL: "border-transparent bg-destructive text-white",
};

export function SeverityBadge({
  severity,
  className,
}: {
  severity: Severity;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn(SEVERITY_STYLES[severity], "font-medium", className)}>
      {severity}
    </Badge>
  );
}

/**
 * The blindness ladder (Plate 07). The point is not that a camera never
 * degrades -- it is that degrading is never silent.
 */
const CAMERA_STYLES: Record<CameraStatus, string> = {
  FULL: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  DEGRADED: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  MOTION_ONLY: "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-300",
  RECORD_ONLY: "border-destructive/40 bg-destructive/10 text-destructive",
  DEAD: "border-transparent bg-destructive text-white",
};

/**
 * Severity where a full badge would shout.
 *
 * Same fixed scale as SeverityBadge, quieter form -- a scanned column of
 * twenty rows does not need twenty filled badges competing with the one
 * incident that actually needs a decision. This is not a third colour system;
 * it is the second rendering of the one we already have.
 */
const SEVERITY_DOT: Record<Severity, string> = {
  INFO: "bg-muted-foreground/40",
  WARNING: "bg-amber-500",
  CRITICAL: "bg-destructive",
};

export function SeverityDot({
  severity,
  className,
}: {
  severity: Severity;
  className?: string;
}) {
  return (
    <span
      aria-label={severity}
      title={severity}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", SEVERITY_DOT[severity], className)}
    />
  );
}

export function CameraStatusPill({
  status,
  className,
}: {
  status: CameraStatus;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn(CAMERA_STYLES[status], "font-mono text-xs", className)}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

/**
 * A made-up sensor feed presented as real is the single thing that would sink
 * this project. The flag comes from the event's own `simulated` field, set
 * once per adapter, so it cannot be forgotten at a call site.
 */
export function SimulatedBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-dashed font-mono text-xs", className)}>
      SIMULATED
    </Badge>
  );
}

/** An animal on the fence line is a record, not an alarm (#12). */
export function SuppressedBadge({ reason }: { reason: string }) {
  return (
    <Badge variant="secondary" className="font-mono text-xs">
      {humanise(reason)}
    </Badge>
  );
}

/**
 * A shape nobody drew.
 *
 * One component, one wording, so the console cannot describe this state three
 * different ways on three pages. The consequence is in the title rather than
 * the label, because the label has to survive being read at a glance on a dark
 * tile at three in the morning.
 */
export function ProvisionalBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-dashed border-amber-600 font-mono text-xs text-amber-600", className)}
      title="Default shape - nobody has drawn this against the camera's view. Crossings are recorded and never alerted."
    >
      PROVISIONAL
    </Badge>
  );
}
