import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SeverityBadge, SimulatedBadge, SuppressedBadge } from "./badges";
import { clockTime, dateTime, humanise, percent } from "@/lib/format";
import type { IbvapEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The raw record, shared by the event log and history search.
 *
 * Suppressed rows are shown, dimmed rather than hidden: an animal on the fence
 * is written to the log and never alerted on, and being able to see that
 * happening is what makes the suppression trustworthy instead of a black box.
 */
export function EventTable({ events, showDate }: { events: IbvapEvent[]; showDate?: boolean }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Seq</TableHead>
            <TableHead className="w-28">{showDate ? "When" : "Time"}</TableHead>
            <TableHead className="w-24">Severity</TableHead>
            <TableHead>Class</TableHead>
            <TableHead>Rule</TableHead>
            <TableHead className="w-24 text-right">Conf.</TableHead>
            <TableHead className="w-48">Flags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.id} className={cn(!event.alertable && "opacity-60")}>
              <TableCell className="font-mono text-xs text-muted-foreground">{event.seq}</TableCell>
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
                  {!event.alertable && event.suppressedReason && (
                    <SuppressedBadge reason={event.suppressedReason} />
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
