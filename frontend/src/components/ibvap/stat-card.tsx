import type { LucideIcon } from "lucide-react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * One number, what it means, and which way it is moving.
 *
 * WHY THE DIRECTION OF "GOOD" IS A PROP. A rising intrusion count is bad; a
 * falling response time is good. A card that colours every increase green (or
 * red) is worse than one with no colour at all, because it teaches an operator
 * to read the colour instead of the number and then lies to them once. So the
 * caller states which direction is an improvement and the card says nothing it
 * was not told.
 *
 * WHY THE SPARKLINE IS NOT A CHART LIBRARY. It is a polyline over N buckets
 * with no axes, no ticks and no tooltip -- it exists to answer "is this normal
 * for this hour" at a glance, not to be read off. Anything precise enough to
 * read off belongs on the history screen, where the numbers have labels.
 *
 * Generic: it knows nothing about fences, cameras or zones. Only the fence page
 * mounts it today.
 */

export interface StatCardProps {
  icon: LucideIcon;
  label: string;
  /** Already formatted -- "13", "778", "12s". The card never does units. */
  value: string;
  /** The window this covers, said plainly. */
  caption?: string;
  /** Change against the previous equivalent window. */
  delta?: {
    /** Formatted the same way: "2", "12%". */
    value: string;
    direction: "up" | "down";
  };
  /**
   * Which direction is an improvement, so the delta can be coloured honestly.
   * "neutral" leaves it grey, which is the right answer whenever nobody has
   * decided what better looks like.
   */
  better?: "up" | "down" | "neutral";
  /** One value per bucket, oldest first. Drawn as bars or a line. */
  series?: number[];
  /** Bars read as counts, a line reads as a rate. Match the number above. */
  shape?: "bars" | "line";
  /** Tailwind text colour for the icon and sparkline. */
  tone?: string;
  className?: string;
}

export function StatCard({
  icon: Icon,
  label,
  value,
  caption,
  delta,
  better = "neutral",
  series,
  shape = "bars",
  tone = "text-sky-600 dark:text-sky-400",
  className,
}: StatCardProps) {
  const good =
    better === "neutral" ? null : delta ? (delta.direction === better) : null;

  return (
    <Card className={cn("gap-0 p-4", className)}>
      <div className="flex items-center gap-2">
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md bg-muted", tone)}>
          <Icon className="size-4" />
        </span>
        <span className="truncate text-sm font-medium text-muted-foreground">{label}</span>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums leading-none">{value}</span>
            {delta && (
              <span
                className={cn(
                  "flex items-center gap-0.5 text-xs font-medium tabular-nums",
                  good === null && "text-muted-foreground",
                  good === true && "text-emerald-600 dark:text-emerald-400",
                  good === false && "text-destructive",
                )}
              >
                {delta.direction === "up" ? (
                  <ArrowUpIcon className="size-3" />
                ) : (
                  <ArrowDownIcon className="size-3" />
                )}
                {delta.value}
              </span>
            )}
          </div>
          {caption && (
            <p className="mt-1.5 truncate text-xs text-muted-foreground">{caption}</p>
          )}
        </div>

        {series && series.length > 1 && (
          <Sparkline series={series} shape={shape} className={cn("shrink-0", tone)} />
        )}
      </div>
    </Card>
  );
}

/**
 * A shape, not a chart.
 *
 * Drawn in a 100x32 viewBox with `preserveAspectRatio="none"` so it stretches
 * to whatever space is left beside the number. That distortion is acceptable
 * precisely because nothing here is meant to be measured -- the eye is looking
 * for "flat", "climbing" or "spiky", all of which survive a squeeze.
 *
 * An all-zero series still draws: a flat line along the bottom is the honest
 * picture of a quiet day, and an empty box would read as "no data", which is a
 * different and much more alarming statement.
 */
function Sparkline({
  series,
  shape,
  className,
}: {
  series: number[];
  shape: "bars" | "line";
  className?: string;
}) {
  const peak = Math.max(...series, 1);
  const step = 100 / series.length;

  return (
    <svg
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className={cn("h-8 w-24", className)}
      aria-hidden
    >
      {shape === "bars"
        ? series.map((value, index) => {
            // Minimum 1 unit tall so a zero bucket is still visibly a bucket.
            const height = Math.max(1, (value / peak) * 30);
            return (
              <rect
                key={index}
                x={index * step + step * 0.15}
                y={32 - height}
                width={step * 0.7}
                height={height}
                rx={Math.min(1, step * 0.3)}
                fill="currentColor"
                opacity={0.55 + 0.45 * (value / peak)}
              />
            );
          })
        : (
          <polyline
            points={series
              .map((value, index) => {
                const x = index * step + step / 2;
                const y = 31 - (value / peak) * 29;
                return `${x},${y}`;
              })
              .join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
    </svg>
  );
}
