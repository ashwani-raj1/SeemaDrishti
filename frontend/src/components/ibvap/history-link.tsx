import { Link } from "react-router-dom";
import { HistoryIcon } from "lucide-react";
import { useClient } from "@/client/context";
import { cn } from "@/lib/utils";

/**
 * "Search the record for this camera / zone / kind."
 *
 * HIDDEN, not disabled, for operators. `/history` is supervisor-only and the
 * sidebar already leaves it out for them; a visible link to a 403 is worse
 * than no link, because it teaches the operator that the console lies about
 * what they can do.
 *
 * It only sets the filters. The search itself is written to the audit log
 * against whoever runs it, so the history screen waits for a deliberate press
 * rather than firing because somebody followed a link -- otherwise the audit
 * trail records an intention nobody had.
 */
export function HistoryLink({
  cameraId,
  zoneId,
  kind,
  label = "Search the record",
  className,
}: {
  cameraId?: string | null;
  zoneId?: string | null;
  kind?: string;
  label?: string;
  className?: string;
}) {
  const { role } = useClient();
  if (role === "operator") return null;

  const params = new URLSearchParams();
  if (cameraId) params.set("camera_id", cameraId);
  if (zoneId) params.set("zone_id", zoneId);
  if (kind) params.set("kind", kind);
  if ([...params].length === 0) return null;

  return (
    <Link
      to={`/history?${params.toString()}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground",
        "underline-offset-2 hover:text-foreground hover:underline",
        className,
      )}
    >
      <HistoryIcon className="size-3.5" />
      {label}
    </Link>
  );
}
