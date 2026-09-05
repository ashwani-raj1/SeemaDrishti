/**
 * "Always show why the alarm fired" (#21).
 *
 * An alert nobody can explain is an alert that gets ignored, and this is also
 * the structural answer to "black-box AI at the border": the box, the path,
 * the zone and the named rule are all drawn from the stored evidence, so the
 * explanation cannot drift from what actually happened.
 *
 * Every coordinate is normalised 0..1 against the frame, which is why this
 * scales to any container for free -- and why a zone survives a camera swap.
 */
import type { Evidence } from "@/lib/types";

/**
 * A 0..100 viewBox with a non-uniform aspect ratio: `vector-effect` keeps the
 * strokes an honest width instead of stretching with the box.
 */
export function EvidenceOverlay({ evidence, className }: { evidence: Evidence; className?: string }) {
  const { zone, path, crossedAt, bbox } = evidence;
  const at = (p: readonly number[]) => `${(p[0] ?? 0) * 100},${(p[1] ?? 0) * 100}`;

  return (
    <div
      className={className}
      data-slot="evidence-overlay"
      role="img"
      aria-label="Detection geometry: zone, track path and crossing point"
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="size-full rounded-md border bg-muted/40"
      >
        <defs>
          <pattern id="ibvap-grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path
              d="M10 0 L0 0 0 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="0.25"
              className="text-muted-foreground/25"
              vectorEffect="non-scaling-stroke"
            />
          </pattern>
        </defs>
        <rect width="100" height="100" fill="url(#ibvap-grid)" />

        {/* The zone. A line and a polygon are the same primitive, drawn differently. */}
        {zone?.geometry === "line" && zone.points.length >= 2 && (
          <polyline
            points={zone.points.map(at).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="4 3"
            className="text-primary"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {zone?.geometry === "polygon" && zone.points.length >= 3 && (
          <polygon
            points={zone.points.map(at).join(" ")}
            className="fill-primary/10 text-primary"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* Where it walked. */}
        {path && path.length >= 2 && (
          <polyline
            points={path.map(at).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-foreground/70"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {bbox && (
          <rect
            x={(bbox[0] ?? 0) * 100}
            y={(bbox[1] ?? 0) * 100}
            width={(bbox[2] ?? 0) * 100}
            height={(bbox[3] ?? 0) * 100}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-destructive"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {crossedAt && (
          <circle
            cx={(crossedAt[0] ?? 0) * 100}
            cy={(crossedAt[1] ?? 0) * 100}
            r="1.8"
            className="fill-destructive"
          />
        )}
      </svg>
    </div>
  );
}
