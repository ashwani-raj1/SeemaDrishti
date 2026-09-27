import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CctvIcon, PencilRulerIcon, PlusIcon, SaveIcon, Trash2Icon, TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageShell } from "@/components/ibvap/page-shell";
import { EvidenceOverlay } from "@/components/ibvap/evidence-overlay";
import { Spinner } from "@/components/ibvap/spinner";
import { useClient } from "@/client/context";
import { useConsoleStore } from "@/client/console-store";
import { HistoryLink } from "@/components/ibvap/history-link";
import { api, isConflict, isForbidden } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { humanise } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Direction, MonitoringZone, ZoneCamera } from "@/lib/types";
import { NewZoneDialog } from "./new-zone-dialog";
import { ZoneActions } from "./zone-actions";
import { ShapeEditor } from "./shape-editor";
import { TargetEditor, TargetList, toDraft, type DraftTarget } from "./target-editor";

/**
 * Monitoring zones.
 *
 * A zone is a named place watched by one or more cameras. It owns the policy —
 * what must be detected against, in what order — while each camera owns its own
 * shape, because a polygon drawn in one camera's frame means nothing in
 * another's. Any camera may state exceptions to the policy without the other
 * cameras in the zone changing.
 */
export function ZonesScreen() {
  const { role, refreshServer } = useClient();
  const [params] = useSearchParams();
  const wanted = params.get("zone");
  const zones = useResource(() => api.zones(), []);

  // The header's zone filter. Honoured here rather than ignored: a filter that
  // changes nothing is what the old hardcoded one did, and it taught people
  // the control was decoration.
  const zoneFilter = useConsoleStore((state) => state.zoneFilter);
  const setZoneFilter = useConsoleStore((state) => state.setZoneFilter);
  const shown = zones.data?.filter((zone) => !zoneFilter || zone.id === zoneFilter);
  // A filter naming a zone this list does not contain would render an empty
  // page with no explanation, so say which one and offer the way out.
  const filteredAway = Boolean(zoneFilter) && (zones.data?.length ?? 0) > (shown?.length ?? 0);

  const canEdit = role !== "operator";

  const reload = () => {
    zones.reload();
    void refreshServer();
  };

  return (
    <PageShell
      title="Zones"
      description="Named places, the cameras that watch them, and what matters at each."
      actions={<NewZoneDialog canEdit={canEdit} onCreated={reload} />}
    >
      {zones.loading && !zones.data && <Spinner />}
      {zones.error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          {zones.error.message}
        </p>
      )}

      {filteredAway && (
        <p className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-4 py-2.5 text-sm">
          <span className="text-muted-foreground">
            Filtered to one zone by the header.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setZoneFilter(null)}>
            Show all zones
          </Button>
        </p>
      )}

      {zones.data?.length === 0 && (
        <div className="rounded-md border border-dashed p-10 text-center">
          <p className="text-sm font-medium">No zones yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create one: name it, pick its cameras, and draw what each of them
            watches.
          </p>
        </div>
      )}

      <div className="grid gap-4">
        {shown?.map((zone) => (
          <ZoneCard
            key={zone.id}
            zone={zone}
            canEdit={canEdit}
            focused={zone.id === wanted}
            onChanged={reload}
          />
        ))}
      </div>
    </PageShell>
  );
}

function ZoneCard({
  zone,
  canEdit,
  focused,
  onChanged,
}: {
  zone: MonitoringZone;
  canEdit: boolean;
  focused?: boolean;
  onChanged: () => void;
}) {
  const live = zone.cameras.filter((camera) => camera.active);
  const unplaced = live.filter((camera) => !camera.placed).length;

  return (
    <Card className={cn(focused && "ring-2 ring-primary")}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="truncate">{zone.name}</span>
          <Badge variant="outline" className="font-normal">
            {humanise(zone.kind)}
          </Badge>
          {zone.area && (
            <Badge variant="secondary" className="font-normal">
              {zone.area}
            </Badge>
          )}
          {!zone.active && <Badge variant="destructive">inactive</Badge>}
          <ZoneActions zone={zone} canEdit={canEdit} onChanged={onChanged} />
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            {live.length} camera{live.length === 1 ? "" : "s"}
          </span>
          {unplaced > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-500">
              <TriangleAlertIcon className="size-3.5" />
              {unplaced} shape{unplaced === 1 ? "" : "s"} not positioned yet
            </span>
          )}
          <HistoryLink zoneId={zone.id} label="Everything recorded here" />
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Tabs defaultValue="policy">
          <TabsList>
            <TabsTrigger value="policy">Detect against</TabsTrigger>
            <TabsTrigger value="cameras">Cameras ({live.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="policy" className="pt-4">
            <ZonePolicy zone={zone} />
          </TabsContent>

          <TabsContent value="cameras" className="space-y-4 pt-4">
            {live.map((camera) => (
              <CameraRow key={camera.bindingId} zone={zone} camera={camera} />
            ))}
            <p className="text-xs text-muted-foreground">
              Cameras join and leave this zone in the edit wizard, so the whole
              change is one decision rather than several half-applied ones.
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/**
 * The zone's policy, read only.
 *
 * WHY NOTHING HERE IS EDITABLE ANY MORE. This card used to be four separate
 * editors -- a name/kind dialog, this target list, a redraw button per camera,
 * a per-camera exception editor, and add/remove camera buttons -- each writing
 * through its own endpoint the moment you touched it. Creating a zone was one
 * guided flow; changing one was a scavenger hunt across five controls that
 * applied piecemeal, so a supervisor halfway through rearranging a zone had
 * already half-applied it.
 *
 * Editing now happens in one place, the same wizard that creates a zone, and
 * lands as one atomic `PUT /api/zones/:id`. The card's job is to show what the
 * zone IS. Deactivating is still here because that is not an edit -- it is
 * taking the whole zone out of service, and it has its own confirmation.
 */
function ZonePolicy({ zone }: { zone: MonitoringZone }) {
  return (
    <div className="space-y-3">
      <FieldDescription>
        The order is the priority, highest first. Anything set to log only is
        written to the record and never raised — which is what keeps a night
        from filling with cattle.
      </FieldDescription>
      <TargetList targets={zone.targets} />
    </div>
  );
}

/** One camera's membership: its shape, its patience, and any exceptions. */
function CameraRow({ zone, camera }: { zone: MonitoringZone; camera: ZoneCamera }) {
  return (
    <div className="rounded-md border">
      <div className="grid gap-4 p-3 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          <EvidenceOverlay
            evidence={{
              zone: {
                id: zone.id,
                name: zone.name,
                kind: zone.kind,
                geometry: camera.geometry,
                points: camera.points,
              },
            }}
            className={cn("aspect-video w-full rounded border", !camera.placed && "opacity-50")}
          />
          {!camera.placed && (
            <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-500">
              Nobody has drawn this against the camera's view. Crossings of it
              are recorded and never alerted on.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">{camera.cameraName}</span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {camera.geometry}
            </Badge>
            <Badge variant="secondary" className="font-normal">
              {camera.points.length} point{camera.points.length === 1 ? "" : "s"}
            </Badge>
          </div>

          <dl className="grid max-w-md grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Alert on</dt>
            <dd className="text-right">
              {camera.direction === "both" ? "both directions" : `${camera.direction} only`}
            </dd>
            <dt className="text-muted-foreground">Wait for</dt>
            <dd className="text-right font-mono">{camera.confirmSeconds}s</dd>
          </dl>

          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">
              What this camera actually watches for
            </p>
            <TargetList targets={camera.effectiveTargets} />
            {camera.overrides.length > 0 && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {camera.overrides.length} exception
                {camera.overrides.length === 1 ? "" : "s"} to the zone policy.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}