/**
 * The faceted result list, shared by both intelligence modes.
 *
 * AI chat drops a list here when the operator asked for "everything around the
 * north fence"; Manual Search drops one here when a filter set matched several
 * records. Neither knows about the other -- they both produce ResultItem[] and
 * this renders it. That is the point of the common result model: one list
 * component, one look, whichever mode filled it.
 */
import { useMemo, useState } from "react";
import { CameraIcon, MapPinIcon } from "lucide-react";
import { clockTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { facetCounts, isImageUrl, type FacetId, type ResultItem } from "../result-model";

interface ResultListProps {
  label: string;
  items: ResultItem[];
  selectedId?: string | null;
  onSelect?: (item: ResultItem) => void;
  /**
   * Set when some filters had to be applied in the browser because the
   * endpoint does not support them. Telling the operator the search was
   * bounded is the difference between "no matches" and "no matches in the
   * last 500 records", and only one of those is honest.
   */
  scannedNote?: string | null;
  className?: string;
}

const SEVERITY_STYLE: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700",
  WARNING: "bg-amber-100 text-amber-700",
  INFO: "bg-slate-100 text-slate-600",
};

export function ResultList({
  label,
  items,
  selectedId,
  onSelect,
  scannedNote,
  className,
}: ResultListProps) {
  const [facet, setFacet] = useState<FacetId>("all");
  const facets = useMemo(() => facetCounts(items), [items]);
  const visible = facet === "all" ? items : items.filter((item) => item.facet === facet);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-baseline justify-between gap-2 px-1">
        <span className="text-sm font-semibold text-slate-900">
          {label} ({items.length})
        </span>
        {scannedNote && <span className="text-[10px] text-slate-400">{scannedNote}</span>}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5 px-1">
        {facets.map((entry) => (
          <button
            key={entry.id}
            type="button"
            disabled={entry.count === 0 && entry.id !== "all"}
            onClick={() => setFacet(entry.id)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              facet === entry.id
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-blue-100 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700",
              entry.count === 0 && entry.id !== "all" && "cursor-not-allowed opacity-40",
            )}
          >
            {entry.label} {entry.count}
          </button>
        ))}
      </div>

      <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {visible.length === 0 && (
          <p className="rounded-lg bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
            Nothing matches this filter.
          </p>
        )}

        {visible.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect?.(item)}
            className={cn(
              "w-full rounded-lg border p-2.5 text-left transition-colors",
              item.id === selectedId
                ? "border-blue-400 bg-blue-50"
                : "border-transparent bg-white hover:border-blue-100 hover:bg-slate-50",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[9px] font-bold",
                      SEVERITY_STYLE[item.severity] ?? SEVERITY_STYLE.INFO,
                    )}
                  >
                    {item.severity}
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">
                    {clockTime(item.occurredAt)}
                  </span>
                  {item.status && (
                    <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">
                      {item.status}
                    </span>
                  )}
                </div>

                <div className="mt-1 truncate text-xs font-semibold text-slate-800">
                  {item.title}
                </div>

                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                  {item.cameraName && (
                    <span className="inline-flex items-center gap-1">
                      <CameraIcon className="h-3 w-3 text-slate-400" />
                      {item.cameraName}
                    </span>
                  )}
                  {item.zoneName && (
                    <span className="inline-flex items-center gap-1">
                      <MapPinIcon className="h-3 w-3 text-slate-400" />
                      {item.zoneName}
                    </span>
                  )}
                </div>
              </div>

              {isImageUrl(item.snapshot) && (
                <img
                  src={item.snapshot}
                  alt=""
                  className="h-10 w-14 shrink-0 rounded border border-blue-100 object-cover"
                />
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
