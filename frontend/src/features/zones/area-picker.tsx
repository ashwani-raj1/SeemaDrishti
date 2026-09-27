import { useMemo, useState } from "react";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Picking the area a zone belongs to.
 *
 * An area is a LABEL and nothing else -- free text grouping zones that sit on
 * the same stretch of ground. It used to be a polygon in `client/geography.ts`
 * with the cameras inside it computed from their surveyed positions, which
 * read as clever and behaved as a trap: the four areas were hardcoded, an
 * operator could not add a fifth without a code change, and the polygon had no
 * bearing on anything the detector did. The label it left on the zone was the
 * only part anybody used.
 *
 * WHY THE LIST IS DERIVED FROM ZONES, not stored anywhere. `GET
 * /api/zones/areas` returns the DISTINCT labels the live zones carry. So an
 * area exists because a zone uses it, and stops existing when the last one
 * does -- there is no list to prune, nothing to leave orphaned, and no way for
 * the picker to offer an area that means nothing.
 *
 * Typing filters that list; typing something that matches nothing offers to
 * use it as a new area, which is the entire creation flow. Nothing is written
 * until the zone itself is saved.
 */

export function AreaPicker({
  areas,
  value,
  onChange,
  disabled,
}: {
  /** Labels already in use, from the node. */
  areas: string[];
  value: string | null;
  onChange: (area: string | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");

  const typed = query.trim();
  const matches = useMemo(() => {
    if (!typed) return areas;
    const needle = typed.toLowerCase();
    return areas.filter((area) => area.toLowerCase().includes(needle));
  }, [areas, typed]);

  // Offered only when nothing already matches exactly, case-insensitively.
  // Without that check, typing the full name of an existing area offers to
  // "create" it, and a post ends up with "Fence line north" and "fence line
  // north" as two areas that look identical in every list.
  const exact = areas.some((area) => area.toLowerCase() === typed.toLowerCase());
  const canCreate = typed.length > 0 && !exact;

  const choose = (area: string) => {
    onChange(area);
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-2">
      {value ? (
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="gap-1.5 py-1 pl-2.5 pr-1.5 font-normal">
            {value}
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(null)}
                className="rounded-sm opacity-60 transition-opacity hover:opacity-100"
                aria-label={`Remove ${value} from this zone`}
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </Badge>
          <span className="text-xs text-muted-foreground">
            Grouping only — it changes nothing about what is detected.
          </span>
        </div>
      ) : (
        <>
          <Input
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              areas.length > 0 ? "Type to filter, or type a new area" : "Type an area name"
            }
            // Enter takes the single remaining match, or creates what was
            // typed. A picker that needs the mouse for the common case is a
            // picker somebody stops using.
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (matches.length === 1 && matches[0]) choose(matches[0]);
              else if (canCreate) choose(typed);
            }}
          />

          <div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
            {matches.map((area) => (
              <button
                key={area}
                type="button"
                disabled={disabled}
                onClick={() => choose(area)}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
              >
                <CheckIcon className="size-3.5 shrink-0 opacity-0" />
                {area}
              </button>
            ))}

            {canCreate && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => choose(typed)}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
              >
                <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
                Use <span className="font-medium">{typed}</span> as a new area
              </button>
            )}

            {matches.length === 0 && !canCreate && (
              <p className="px-2.5 py-3 text-xs text-muted-foreground">
                {areas.length === 0
                  ? "No areas yet. The first one is whatever you type."
                  : "Nothing matches."}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
