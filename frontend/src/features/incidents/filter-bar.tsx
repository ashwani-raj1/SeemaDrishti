import { FilterXIcon, RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { relative } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  activeFilterCount, NO_FILTERS, RANGES, type IncidentFilters,
} from "./use-incidents";

/**
 * Narrowing the queue, and proving it is current.
 *
 * WHY A REFRESH BUTTON ON A SCREEN THAT ALREADY PUSHES. The node streams
 * incidents over SSE, so this list is live and the button is redundant --
 * right up until the link drops. A dead stream and a quiet night look exactly
 * the same on screen, and the difference matters enormously. The button is how
 * an operator settles that question without reloading the page, which is why
 * it stamps the time it last succeeded rather than just spinning.
 *
 * WHY "ANY" AND NOT "ALL" on each select. "All severities" reads like a filter
 * that is doing something; "Any severity" reads like one that is not. On a
 * screen whose whole job is to be trusted about what it is hiding, that
 * distinction is worth the two characters.
 */

/** The event kinds the node can produce. Fixed, not derived from what is on
 *  screen -- a list that changes as the queue empties is a list an operator
 *  cannot learn. */
const KINDS = [
  { value: "zone_crossing", label: "Zone crossing" },
  { value: "camera_health", label: "Camera health" },
  { value: "plate_read", label: "Plate read" },
  { value: "reidentification", label: "Re-identification" },
];

const SEVERITIES = ["CRITICAL", "WARNING", "INFO"];

export function IncidentFilterBar({
  filters,
  onChange,
  classes,
  onRefresh,
  refreshing,
  loadedAt,
}: {
  filters: IncidentFilters;
  onChange: (next: IncidentFilters) => void;
  /** Classes actually present, so the menu cannot offer a dead end. */
  classes: string[];
  onRefresh: () => void;
  refreshing: boolean;
  loadedAt: Date | null;
}) {
  const set = <K extends keyof IncidentFilters>(key: K, value: IncidentFilters[K]) =>
    onChange({ ...filters, [key]: value });

  const active = activeFilterCount(filters);

  // The Select primitive cannot hold "" as a value, so "any" is the sentinel
  // and is translated at the boundary rather than leaking into the filter type
  // the query is built from.
  const ANY = "any";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={filters.range}
        onValueChange={(value) => set("range", value as IncidentFilters["range"])}
      >
        <SelectTrigger size="sm" className="h-8 w-[150px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RANGES.map((range) => (
            <SelectItem key={range.id} value={range.id}>
              {range.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.kind || ANY}
        onValueChange={(value) => set("kind", value === ANY ? "" : value)}
      >
        <SelectTrigger size="sm" className="h-8 w-[150px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any event type</SelectItem>
          {KINDS.map((kind) => (
            <SelectItem key={kind.value} value={kind.value}>
              {kind.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.severity || ANY}
        onValueChange={(value) => set("severity", value === ANY ? "" : value)}
      >
        <SelectTrigger size="sm" className="h-8 w-[130px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any severity</SelectItem>
          {SEVERITIES.map((severity) => (
            <SelectItem key={severity} value={severity}>
              {severity}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {classes.length > 0 && (
        <Select
          value={filters.class || ANY}
          onValueChange={(value) => set("class", value === ANY ? "" : value)}
        >
          <SelectTrigger size="sm" className="h-8 w-[130px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any class</SelectItem>
            {classes.map((klass) => (
              <SelectItem key={klass} value={klass}>
                {klass}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Not a severity filter. An incident exists for every event, alerted or
          not, so this is the difference between "what the system recorded" and
          "what it asked for a human about". */}
      <Button
        size="sm"
        variant={filters.alertedOnly ? "secondary" : "outline"}
        className="h-8 text-xs"
        onClick={() => set("alertedOnly", !filters.alertedOnly)}
        title="Hide incidents the system recorded but never raised an alert for"
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            filters.alertedOnly ? "bg-destructive" : "bg-muted-foreground/40",
          )}
        />
        Alerted only
      </Button>

      {active > 0 && (
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          onClick={() => onChange(NO_FILTERS)}
        >
          <FilterXIcon className="size-3.5" />
          Clear
          <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
            {active}
          </Badge>
        </Button>
      )}

      <div className="ml-auto flex items-center gap-2">
        {loadedAt && (
          <span className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">
            updated {relative(loadedAt.toISOString())}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
    </div>
  );
}
