import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ProvisionalBadge, SeverityBadge, SimulatedBadge, SuppressedBadge } from "./badges";
import { clockTime, dateTime, humanise, percent } from "@/lib/format";
import type { IbvapEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The raw record, shared by the event log and history search.
 *
 * Suppressed rows are shown, dimmed rather than hidden: an animal on the fence
 * is written to the log and never alerted on, and being able to see that
 * happening is what makes the suppression trustworthy instead of a black box.
 * The same now goes for a crossing of a shape nobody drew.
 *
 * `onOpen` rather than a `useNavigate` in here: this is a shared component and
 * routing is the feature's business, the same instinct that keeps a vision
 * module from naming a transport. A row is clickable only when the event has
 * an incident to open.
 */
export function EventTable({
  events,
  showDate,
  showPlace,
  onOpen,
}: {
  events: IbvapEvent[];
  showDate?: boolean;
  /** Zone and camera columns. A search without them is not a query tool. */
  showPlace?: boolean;
  onOpen?: (event: IbvapEvent) => void;
}) {
  /** Zone ids are long and the name is not on the event; the id, truncated,
   *  is still the thing an operator matches against the zones page. */
  const place = (value: string | null) => value ?? "—";

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Seq</TableHead>
            <TableHead className="w-28">{showDate ? "When" : "Time"}</TableHead>
            <TableHead className="w-24">Severity</TableHead>
            <TableHead>Class</TableHead>
            {showPlace && <TableHead className="w-40">Camera</TableHead>}
            {showPlace && <TableHead className="w-40">Zone</TableHead>}
            <TableHead>Rule</TableHead>
            <TableHead className="w-24 text-right">Conf.</TableHead>
            <TableHead className="w-56">Flags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => {
            const openable = Boolean(onOpen && event.incidentId);
            return (
              <TableRow
                key={event.id}
                className={cn(
                  !event.alertable && "opacity-60",
                  openable && "cursor-pointer hover:bg-muted/50",
                )}
                onClick={openable ? () => onOpen!(event) : undefined}
                title={openable ? "Open the incident this belongs to" : undefined}
              >
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {event.seq}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {showDate ? dateTime(event.occurredAt) : clockTime(event.occurredAt)}
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={event.severity} />
                </TableCell>
                <TableCell className="font-medium">
                  {event.class ? humanise(event.class) : humanise(event.kind)}
                  {event.direction && (
                    <span className="text-muted-foreground"> · {event.direction}</span>
                  )}
                </TableCell>
                {showPlace && (
                  <TableCell className="truncate font-mono text-xs text-muted-foreground">
                    {place(event.cameraId)}
                  </TableCell>
                )}
                {showPlace && (
                  <TableCell className="truncate font-mono text-xs text-muted-foreground">
                    {place(event.zoneId)}
                  </TableCell>
                )}
                <TableCell className="truncate font-mono text-xs text-muted-foreground">
                  {event.rule ?? "—"}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {percent(event.confidence)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    {event.source.simulated && <SimulatedBadge />}
                    {event.source.type !== "camera" && (
                      <Badge variant="outline" className="font-mono text-xs">
                        {event.source.type}
                      </Badge>
                    )}
                    {event.evidence?.provisional === true && <ProvisionalBadge />}
                    {!event.alertable && event.suppressedReason && (
                      <SuppressedBadge reason={event.suppressedReason} />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
