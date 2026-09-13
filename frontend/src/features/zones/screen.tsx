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
import { sectorById } from "@/client/geography";
import { api, isForbidden } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { humanise } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Direction, MonitoringZone, ZoneCamera } from "@/lib/types";
import { NewZoneDialog } from "./new-zone-dialog";
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

      {zones.data?.length === 0 && (
        <div className="rounded-md border border-dashed p-10 text-center">
          <p className="text-sm font-medium">No zones yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Start from an area — the cameras covering it are worked out for you.
          </p>
        </div>
      )}

      <div className="grid gap-4">
        {zones.data?.map((zone) => (
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
  const sector = zone.sector ? sectorById(zone.sector) : undefined;
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
          {sector && (
            <Badge variant="secondary" className="font-normal">
              {sector.label}
            </Badge>
          )}
          {!zone.active && <Badge variant="destructive">inactive</Badge>}
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
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Tabs defaultValue="policy">
          <TabsList>
            <TabsTrigger value="policy">Detect against</TabsTrigger>
            <TabsTrigger value="cameras">Cameras ({live.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="policy" className="pt-4">
            <ZonePolicy zone={zone} canEdit={canEdit} onChanged={onChanged} />
          </TabsContent>

          <TabsContent value="cameras" className="space-y-4 pt-4">
            {live.map((camera) => (
              <CameraRow
                key={camera.bindingId}
                zone={zone}
                camera={camera}
                canEdit={canEdit}
                onChanged={onChanged}
              />
            ))}
            <AddCamera zone={zone} canEdit={canEdit} onChanged={onChanged} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/** The zone's own policy: what everything in it watches for, unless told otherwise. */
function ZonePolicy({
  zone,
  canEdit,
  onChanged,
}: {
  zone: MonitoringZone;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<DraftTarget[]>(() => toDraft(zone.targets));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(toDraft(zone.targets)), [zone.targets]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(zone.targets));

  async function save() {
    setSaving(true);
    try {
      await api.setZoneTargets(zone.id, draft, reason.trim() || undefined);
      toast.success(`${zone.name} updated`);
      setReason("");
      onChanged();
    } catch (error) {
      toast.error(
        isForbidden(error) ? "Editing zones needs a supervisor." : (error as Error).message,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <FieldDescription>
        The order is the priority, highest first. Anything set to log only is written to the record
        and never raised — which is what keeps a night from filling with cattle.
      </FieldDescription>

      <TargetEditor targets={draft} onChange={setDraft} disabled={!canEdit} />

      {canEdit && dirty && (
        <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/40 p-3">
          <Field className="min-w-56 flex-1">
            <FieldLabel htmlFor={`reason-${zone.id}`}>Reason for this change</FieldLabel>
            <Input
              id={`reason-${zone.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. fog season, tighten the fence line"
            />
          </Field>
          <Button onClick={save} disabled={saving}>
            <SaveIcon className="size-4" />
            {saving ? "Saving…" : "Save policy"}
          </Button>
        </div>
      )}
    </div>
  );
}

const DIRECTIONS: (Direction | "both")[] = ["inbound", "outbound", "both"];

/** One camera's membership: its shape, its patience, and any exceptions. */
function CameraRow({
  zone,
  camera,
  canEdit,
  onChanged,
}: {
  zone: MonitoringZone;
  camera: ZoneCamera;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [direction, setDirection] = useState(camera.direction);
  const [confirmSeconds, setConfirmSeconds] = useState(camera.confirmSeconds);
  const [overrides, setOverrides] = useState<DraftTarget[]>(() => toDraft(camera.overrides));
  const [editingOverrides, setEditingOverrides] = useState(camera.overrides.length > 0);
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDirection(camera.direction);
    setConfirmSeconds(camera.confirmSeconds);
    setOverrides(toDraft(camera.overrides));
  }, [camera]);

  const shapeDirty =
    direction !== camera.direction || confirmSeconds !== camera.confirmSeconds;
  const overridesDirty =
    JSON.stringify(overrides) !== JSON.stringify(toDraft(camera.overrides));

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await work();
      toast.success(done);
      onChanged();
    } catch (error) {
      toast.error(
        isForbidden(error) ? "This needs a supervisor." : (error as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border">
      <ShapeEditor
        open={drawing}
        onOpenChange={setDrawing}
        zoneId={zone.id}
        zoneName={zone.name}
        cameraId={camera.cameraId}
        cameraName={camera.cameraName}
        geometry={camera.geometry}
        points={camera.points}
        direction={camera.direction}
        confirmSeconds={camera.confirmSeconds}
        onSaved={onChanged}
      />
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
              Placeholder shape — nobody has positioned this against the camera's
              view yet, so it judges nothing useful.
            </p>
          )}
          <Button
            size="sm"
            variant={camera.placed ? "outline" : "default"}
            className="w-full"
            disabled={!canEdit}
            onClick={() => setDrawing(true)}
          >
            <PencilRulerIcon className="size-3.5" />
            {camera.placed ? "Redraw on camera" : "Draw on camera"}
          </Button>
        </div>

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">{camera.cameraName}</span>
            <Badge variant="outline" className="font-mono text-[10px] font-normal">
              {camera.geometry}
            </Badge>
            {camera.cameraStatus !== "FULL" && (
              <Badge variant="secondary" className="font-normal">
                {humanise(camera.cameraStatus)}
              </Badge>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-muted-foreground hover:text-destructive"
              disabled={!canEdit || busy}
              onClick={() =>
                run(
                  () => api.removeZoneCamera(zone.id, camera.cameraId, "no longer covers this zone"),
                  `${camera.cameraName} removed from ${zone.name}`,
                )
              }
            >
              <Trash2Icon className="size-3.5" />
              Remove
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`dir-${camera.bindingId}`}>Alert on</FieldLabel>
              <Select
                value={direction}
                disabled={!canEdit}
                onValueChange={(value) => setDirection(value as Direction | "both")}
              >
                <SelectTrigger id={`dir-${camera.bindingId}`} size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIRECTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option === "both" ? "both directions" : `${option} only`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor={`hold-${camera.bindingId}`}>
                Wait before shouting (seconds)
              </FieldLabel>
              <Input
                id={`hold-${camera.bindingId}`}
                type="number"
                min={0}
                max={60}
                step={0.5}
                value={confirmSeconds}
                disabled={!canEdit}
                onChange={(event) => setConfirmSeconds(Number(event.target.value))}
              />
            </Field>
          </div>

          {shapeDirty && canEdit && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    api.updateZoneCamera(zone.id, camera.cameraId, {
                      direction,
                      confirmSeconds,
                      reason: "retuned for this camera's view",
                    }),
                  `${camera.cameraName} retuned`,
                )
              }
            >
              <SaveIcon className="size-4" />
              Save camera settings
            </Button>
          )}

          <Separator />

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              What this camera actually watches for
            </p>
            <TargetList targets={camera.effectiveTargets} />

            {!editingOverrides ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={!canEdit}
                onClick={() => setEditingOverrides(true)}
              >
                Add an exception for this camera
              </Button>
            ) : (
              <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                <FieldDescription>
                  Exceptions replace the zone policy for the classes listed here, on this camera
                  only. Leave the list empty to go back to the zone policy.
                </FieldDescription>
                <TargetEditor
                  targets={overrides}
                  onChange={setOverrides}
                  disabled={!canEdit}
                  emptyHint="No exceptions — this camera follows the zone policy."
                />
                {overridesDirty && canEdit && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          api.setZoneCameraTargets(
                            zone.id,
                            camera.cameraId,
                            overrides,
                            overrides.length === 0
                              ? "back to the zone policy"
                              : "this camera sees something different",
                          ),
                        `${camera.cameraName} exceptions saved`,
                      )
                    }
                  >
                    <SaveIcon className="size-4" />
                    Save exceptions
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AddCamera({
  zone,
  canEdit,
  onChanged,
}: {
  zone: MonitoringZone;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { cameras } = useClient();
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);

  const already = new Set(zone.cameras.filter((c) => c.active).map((c) => c.cameraId));
  const available = useMemo(
    () => cameras.filter((camera) => !already.has(camera.id)),
    [cameras, zone.cameras],
  );

  if (!canEdit || available.length === 0) return null;

  async function add() {
    if (!choice) return;
    setBusy(true);
    try {
      await api.addZoneCamera(zone.id, choice, "extending coverage of this zone");
      toast.success("Camera added", {
        description: "It starts with a placeholder shape — position it next.",
      });
      setChoice("");
      onChanged();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
      <Field className="min-w-56 flex-1">
        <FieldLabel htmlFor={`add-${zone.id}`}>Add another camera</FieldLabel>
        <Select value={choice} onValueChange={setChoice}>
          <SelectTrigger id={`add-${zone.id}`} size="sm">
            <SelectValue placeholder="Choose a camera" />
          </SelectTrigger>
          <SelectContent>
            {available.map((camera) => (
              <SelectItem key={camera.id} value={camera.id}>
                {camera.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Button size="sm" variant="outline" disabled={!choice || busy} onClick={add}>
        <PlusIcon className="size-4" />
        Add
      </Button>
    </div>
  );
}
