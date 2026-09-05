import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SeverityBadge, SimulatedBadge, SuppressedBadge } from "@/components/ibvap/badges";
import { EvidenceMap } from "@/components/ibvap/evidence-map";
import { ErrorState, LoadingRows } from "@/components/ibvap/states";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { clockTime, dateTime, humanise, percent } from "@/lib/format";
import type { Action, IbvapEvent } from "@/lib/types";

export function IncidentSheet({
  incidentId,
  onOpenChange,
}: {
  incidentId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, error, loading, reload } = useResource(
    () => (incidentId ? api.incident(incidentId) : Promise.resolve(null)),
    [incidentId],
  );

  return (
    <Sheet open={incidentId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="pr-6">{data?.incident.title ?? "Incident"}</SheetTitle>
          <SheetDescription>
            {data
              ? `Opened ${dateTime(data.incident.openedAt)} · ${data.incident.eventCount} events`
              : "Loading the full chain of accountability…"}
          </SheetDescription>
          {data && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <SeverityBadge severity={data.incident.severity} />
              <Badge variant="outline" className="font-mono text-xs">
                {data.incident.status}
              </Badge>
              <Badge variant="secondary" className="font-mono text-xs">
                {data.incident.id}
              </Badge>
            </div>
          )}
        </SheetHeader>

        <Separator />

        <ScrollArea className="flex-1">
          <div className="p-4">
            {loading && <LoadingRows rows={4} />}
            {error && <ErrorState error={error} onRetry={reload} />}

            {data && (
              <Tabs defaultValue="events">
                <TabsList>
                  <TabsTrigger value="events">Why it fired ({data.events.length})</TabsTrigger>
                  <TabsTrigger value="actions">Decisions ({data.actions.length})</TabsTrigger>
                </TabsList>

                <TabsContent value="events" className="flex flex-col gap-4 pt-4">
                  {data.events.map((event) => (
                    <EventCard key={event.id} event={event} />
                  ))}
                </TabsContent>

                <TabsContent value="actions" className="flex flex-col gap-3 pt-4">
                  {data.actions.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No decision recorded yet. This incident is still open.
                    </p>
                  )}
                  {data.actions.map((action) => (
                    <ActionRow key={action.id} action={action} />
                  ))}
                </TabsContent>
              </Tabs>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/** #21 — the box, the path, the zone, the named rule, and the confidence. */
function EventCard({ event }: { event: IbvapEvent }) {
  const { evidence } = event;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={event.severity} />
        <span className="font-mono text-xs text-muted-foreground">seq {event.seq}</span>
        <span className="text-sm font-medium">
          {event.class ? humanise(event.class) : humanise(event.kind)}
          {event.direction && (
            <span className="text-muted-foreground"> · {event.direction}</span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {event.source.simulated && <SimulatedBadge />}
          {!event.alertable && event.suppressedReason && (
            <SuppressedBadge reason={event.suppressedReason} />
          )}
        </div>
      </div>

      <EvidenceMap event={event} className="aspect-video w-full" />
      <p className="text-xs text-muted-foreground">
        Track and crossing point projected onto the ground from the camera's bearing and
        range. No frame is stored — thumbnails and clips are cut from the node's rolling
        buffer on request.
      </p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        <Fact label="Rule" value={event.rule ?? "—"} mono />
        <Fact label="Zone" value={evidence.zone?.name ?? "—"} />
        <Fact label="Confidence" value={percent(event.confidence)} mono />
        <Fact label="Source" value={`${event.source.type} · ${event.source.id}`} mono />
        <Fact label="Occurred" value={clockTime(event.occurredAt)} mono />
        {/* The wait-and-confirm trade (#13), stated openly rather than hidden. */}
        {evidence.confirmSeconds !== undefined && (
          <Fact
            label="Held / required"
            value={`${evidence.heldSeconds ?? "?"}s / ${evidence.confirmSeconds}s`}
            mono
          />
        )}
      </dl>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "truncate font-mono" : "truncate"}>{value}</dd>
    </div>
  );
}

function ActionRow({ action }: { action: Action }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono text-xs">
          {action.verb}
        </Badge>
        <span className="text-muted-foreground">
          {action.actor.name} · {action.actor.role}
        </span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {clockTime(action.at)}
        </span>
      </div>
      {action.reason && <p className="text-sm">“{action.reason}”</p>}
      <code className="truncate font-mono text-[10px] text-muted-foreground">
        {action.hash.slice(0, 32)}…
      </code>
    </div>
  );
}
