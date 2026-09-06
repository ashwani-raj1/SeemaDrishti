import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Severity, TargetAction, ZoneTarget } from "@/lib/types";

/**
 * What must be detected against here, in the order it matters.
 *
 * Rank is the row's position, not a number somebody types -- that way two
 * things can never claim the same rank, and reordering is one gesture instead
 * of renumbering a list by hand.
 *
 * The distinction the whole false-alarm argument rests on lives in the last
 * column: "raise it" against "log it". Cattle cross the fence constantly, and
 * an operator who is woken for them stops trusting the system by the third
 * night. So an animal is recorded and never alerted -- visible in the record,
 * absent from the queue.
 */

const SEVERITIES: Severity[] = ["INFO", "WARNING", "CRITICAL"];

/** Things the detector can be asked to look for. */
export const DETECTION_CLASSES = [
  "person", "vehicle", "tractor", "boat",
  "cattle", "dog", "nilgai", "wild_boar",
];

export interface DraftTarget {
  class: string;
  severity: Severity;
  action: TargetAction;
}

export const toDraft = (targets: ZoneTarget[]): DraftTarget[] =>
  targets.map(({ class: cls, severity, action }) => ({ class: cls, severity, action }));

const SEVERITY_TONE: Record<Severity, string> = {
  INFO: "text-muted-foreground",
  WARNING: "text-amber-600 dark:text-amber-500",
  CRITICAL: "text-destructive",
};

export function TargetEditor({
  targets,
  onChange,
  disabled,
  emptyHint = "Nothing is being detected against here yet.",
}: {
  targets: DraftTarget[];
  onChange: (next: DraftTarget[]) => void;
  disabled?: boolean;
  emptyHint?: string;
}) {
  const used = new Set(targets.map((t) => t.class));
  const available = DETECTION_CLASSES.filter((c) => !used.has(c));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= targets.length) return;
    const next = targets.slice();
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row!);
    onChange(next);
  };

  const patch = (index: number, change: Partial<DraftTarget>) =>
    onChange(targets.map((t, i) => (i === index ? { ...t, ...change } : t)));

  const add = (className: string) =>
    onChange([...targets, { class: className, severity: "WARNING", action: "alert" }]);

  return (
    <div className="space-y-2">
      {targets.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {emptyHint}
        </p>
      ) : (
        <ol className="divide-y rounded-md border">
          {targets.map((target, index) => (
            <li
              key={target.class}
              className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 py-2"
            >
              <span className="w-6 shrink-0 text-center font-mono text-xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>

              <span className="min-w-24 flex-1 truncate text-sm font-medium">
                {target.class.replace(/_/g, " ")}
              </span>

              <Select
                value={target.severity}
                disabled={disabled || target.action === "log_only"}
                onValueChange={(value) => patch(index, { severity: value as Severity })}
              >
                <SelectTrigger className="h-8 w-28" aria-label={`Severity for ${target.class}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((severity) => (
                    <SelectItem key={severity} value={severity}>
                      <span className={SEVERITY_TONE[severity]}>{severity}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={target.action}
                disabled={disabled}
                onValueChange={(value) =>
                  patch(index, {
                    action: value as TargetAction,
                    // A logged-only sighting is never an alarm, so it carries
                    // the lowest severity rather than a misleading one.
                    severity: value === "log_only" ? "INFO" : target.severity,
                  })
                }
              >
                <SelectTrigger className="h-8 w-[8.5rem]" aria-label={`Action for ${target.class}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alert">Raise an alert</SelectItem>
                  <SelectItem value="log_only">Log only</SelectItem>
                </SelectContent>
              </Select>

              <div className="ml-auto flex shrink-0 items-center">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={disabled || index === 0}
                  onClick={() => move(index, index - 1)}
                  aria-label={`Move ${target.class} up`}
                >
                  <ArrowUpIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={disabled || index === targets.length - 1}
                  onClick={() => move(index, index + 1)}
                  aria-label={`Move ${target.class} down`}
                >
                  <ArrowDownIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  disabled={disabled}
                  onClick={() => onChange(targets.filter((_, i) => i !== index))}
                  aria-label={`Remove ${target.class}`}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {available.length > 0 && !disabled && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-xs text-muted-foreground">Add:</span>
          {available.map((className) => (
            <Button
              key={className}
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs font-normal"
              onClick={() => add(className)}
            >
              <PlusIcon className="size-3" />
              {className.replace(/_/g, " ")}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Read-only rendering, for showing a camera what it will actually watch for. */
export function TargetList({ targets, className }: { targets: ZoneTarget[]; className?: string }) {
  if (targets.length === 0) {
    return <p className={cn("text-xs text-muted-foreground", className)}>Nothing configured.</p>;
  }
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)}>
      {targets.map((target) => (
        <li key={target.class}>
          <Badge
            variant={target.action === "log_only" ? "outline" : "secondary"}
            className={cn(
              "gap-1 font-normal",
              target.action === "alert" && SEVERITY_TONE[target.severity],
            )}
          >
            <span className="font-mono text-[10px] tabular-nums opacity-60">{target.priority}</span>
            {target.class.replace(/_/g, " ")}
            {target.action === "log_only" && (
              <span className="text-[10px] opacity-70">log</span>
            )}
            {target.overridden && (
              <span
                className="text-[10px] font-medium text-amber-600 dark:text-amber-500"
                title="This camera overrides the zone policy for this class"
              >
                ●
              </span>
            )}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
