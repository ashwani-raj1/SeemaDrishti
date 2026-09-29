import { useEffect, useMemo, useState } from "react";
import {
  CctvIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, PencilIcon, PlusIcon, SearchIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useClient } from "@/client/context";
import { api, isConflict, isForbidden } from "@/lib/api";
import { humanise } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MonitoringZone, ZoneKind } from "@/lib/types";
import { AreaPicker } from "./area-picker";
import { CameraPanel } from "./camera-panel";
import { ShapeCanvas, shapeProblem, type ShapeDraft } from "./shape-canvas";
import { TargetEditor } from "./target-editor";
import { STAGES, undrawn, useWizardStore, type WizardStage } from "./wizard-store";

/**
 * Creating a monitoring zone, in the order somebody actually decides it.
 *
 *   1 place   which ground, which cameras
 *   2 draw    what each of those cameras is watching, one at a time
 *   3 policy  what matters there, and where one camera differs
 *
 * WHY DRAWING MOVED INSIDE CREATION. It used to be that a zone was created with
 * every camera on a stock placeholder shape, and positioning them was a
 * separate errand afterwards. That is not a neutral default: an undrawn shape
 * is still judged by the detector, and the node records every crossing of it
 * with `alertable = 0` and `suppressed_reason = "zone_not_placed"`
 * (`vision-service/CLAUDE.md` §15). So a zone left half-finished did not sit quiet --
 * it silently logged intrusions nobody was told about, looking for all the
 * world like coverage. Drawing here makes the normal path produce a zone that
 * actually alerts.
 *
 * A camera can still join undrawn: pressing on past a dead feed is allowed,
 * and the footer says how many are in that state before anything is saved.
 * What is gone is the version where it happened by default and silently.
 *
 * WHY SEVERITY MOVED INSIDE CREATION. Same argument from the other end. Setting
 * targets after the zone exists means every zone is live under whatever the
 * defaults happened to be for as long as it takes somebody to go and fix them.
 *
 * NOTHING IS WRITTEN UNTIL THE LAST BUTTON. The whole draft lives in
 * `wizard-store.ts` and goes to the node as one `POST /api/zones` carrying the
 * cameras, their shapes and their targets. Cancel at any stage and there is
 * nothing to clean up -- which is the only reason it is safe to make stage 2
 * as long as it is.
 */

const KINDS: ZoneKind[] = [
  "fence_line", "gate", "waterline", "perimeter", "pass", "restricted_area",
];

const STAGE_TITLE: Record<WizardStage, string> = {
  place: "Where and what",
  draw: "Draw each camera",
  policy: "What matters here",
};

const STAGE_BLURB: Record<WizardStage, string> = {
  place: "Name the zone, say which stretch of ground it is on, and pick the cameras that watch it.",
  draw: "Draw the line or area on each camera's own picture. These are the exact coordinates the detector judges against.",
  policy: "Set what this zone detects and how loudly. One camera can differ from the rest.",
};

/** The shape a camera starts on when its turn comes up in stage 2. */
const startingShape = (kind: ZoneKind): ShapeDraft => {
  const areaKinds: ZoneKind[] = ["perimeter", "restricted_area", "gate"];
  return areaKinds.includes(kind)
    ? { geometry: "polygon", points: [], direction: "both", confirmSeconds: 2 }
    : { geometry: "line", points: [], direction: "both", confirmSeconds: 2 };
};

export function NewZoneDialog({
  onCreated,
  canEdit,
  /** Pass a zone to edit it. Omit for a new one. */
  zone,
  /** Rendered in place of the default "New zone" button. */
  trigger,
}: {
  onCreated: (zone: MonitoringZone) => void;
  canEdit: boolean;
  zone?: MonitoringZone;
  trigger?: React.ReactNode;
}) {
  const { cameras } = useClient();
  const [open, setOpen] = useState(false);
  const [areas, setAreas] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const store = useWizardStore();
  const { editing, stage, name, kind, area, cameras: picked, targets, reason, focused } = store;

  // The areas in use, fetched when the dialog opens rather than held in the
  // client context: they change only when a zone is created or edited, and a
  // stale list would offer an area that no longer exists.
  useEffect(() => {
    if (!open) return;
    api.zoneAreas().then(setAreas).catch(() => setAreas([]));
  }, [open]);

  const nameOf = useMemo(() => new Map(cameras.map((c) => [c.id, c.name])), [cameras]);
  const pickedIds = useMemo(() => picked.map((c) => c.cameraId), [picked]);

  // A camera belongs to exactly one zone, so one that is already spoken for
  // cannot join this one. Shown disabled with the holder named rather than
  // filtered away: a camera that vanishes from the list is a camera nobody can
  // work out how to use, which is how the old dialog hid a real bug.
  const heldBy = useMemo(
    () => new Map(cameras.flatMap((c) => {
      const zone = c.zones.find((z) => z.active);
      return zone ? ([[c.id, zone.name]] as Array<[string, string]>) : [];
    })),
    [cameras],
  );

  const waiting = undrawn(picked);
  const problem =
    picked.length === 0 ? "Pick at least one camera."
    : !name.trim() ? "Give the zone a name."
    : targets.length === 0 ? "Add at least one thing to detect against."
    : null;

  async function save() {
    if (problem) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        kind,
        area,
        cameras: picked.map((camera) => ({
          cameraId: camera.cameraId,
          ...(camera.shape
            ? {
                geometry: camera.shape.geometry,
                points: camera.shape.points,
                direction: camera.shape.direction,
                confirmSeconds: camera.shape.confirmSeconds,
              }
            : {}),
          // `undefined` leaves this camera's exceptions alone on create and
          // CLEARS them on replace -- an empty array is how "follow the zone
          // policy again" is expressed, so the two must stay distinguishable.
          ...(camera.targets ? { targets: camera.targets } : { targets: [] }),
        })),
        targets,
        reason: reason.trim() || undefined,
      };

      const saved = editing
        ? await api.replaceZone(editing, body)
        : await api.createZone(body);

      const drawn = picked.length - waiting.length;
      toast.success(editing ? `${saved.name} saved` : `${saved.name} created`, {
        description:
          waiting.length === 0
            ? `${drawn} camera${drawn === 1 ? "" : "s"}, all positioned — the detector picks it up within its refresh interval.`
            : `${drawn} of ${picked.length} positioned. The rest are on placeholder shapes and will not alert until drawn.`,
      });
      onCreated(saved);
      setOpen(false);
      store.reset();
    } catch (error) {
      if (isConflict(error)) {
        // Nothing was created: the node rejects the whole call rather than
        // making the zone minus the offending camera, which would report
        // success while leaving a camera the supervisor believes is covered
        // watching nothing.
        toast.error("A camera you picked is already in another zone", {
          description: `${(error as Error).message} Nothing was created.`,
        });
      } else {
        toast.error(
          isForbidden(error) ? "Creating zones needs a supervisor." : (error as Error).message,
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const stageIndex = STAGES.indexOf(stage);
  const canAdvance = stage === "place" ? picked.length > 0 && Boolean(name.trim()) : true;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reset on both edges. On close for the obvious reason; on open
        // because a run that ended in a crash rather than a click would
        // otherwise come back holding shapes drawn against a different zone.
        store.reset();
        if (next && zone) store.load(zone);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" disabled={!canEdit} title={canEdit ? undefined : "Needs a supervisor"}>
            <PlusIcon className="size-4" />
            New zone
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-6xl gap-0 p-0 sm:max-w-6xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-3">
            {zone ? `Edit ${zone.name}` : "New monitoring zone"}
            <span className="flex items-center gap-1.5">
              {STAGES.map((entry, index) => (
                <span
                  key={entry}
                  className={cn(
                    "h-1.5 w-8 rounded-full transition-colors",
                    index <= stageIndex ? "bg-primary" : "bg-muted",
                  )}
                />
              ))}
            </span>
            <span className="text-sm font-normal text-muted-foreground">
              {stageIndex + 1} of {STAGES.length} · {STAGE_TITLE[stage]}
            </span>
          </DialogTitle>
          <DialogDescription>{STAGE_BLURB[stage]}</DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[70vh] gap-0 overflow-hidden lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <ScrollArea className="max-h-[70vh]">
            <div className="space-y-5 p-5">
              {stage === "place" && (
                <PlaceStage
                  areas={areas}
                  cameras={cameras}
                  nameOf={nameOf}
                  heldBy={heldBy}
                  pickedIds={pickedIds}
                />
              )}
              {stage === "draw" && <DrawStage nameOf={nameOf} />}
              {stage === "policy" && <PolicyStage nameOf={nameOf} />}
            </div>
          </ScrollArea>

          {/* ---------------------------------------------------- the ground */}
          <div className="hidden min-h-[460px] border-l bg-muted/30 p-4 lg:block">
            {stage === "draw" ? (
              <DrawCanvas nameOf={nameOf} />
            ) : (
              <CameraPanel
                className="size-full"
                cameraId={focused}
                cameraName={focused ? (nameOf.get(focused) ?? focused) : undefined}
                cameraIds={cameras.map((camera) => camera.id)}
                chosen={pickedIds}
                onPick={store.focus}
              />
            )}
          </div>
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 border-t px-5 py-3">
          {/* Said on every stage, not just the last. The whole reason stage 2
              can be as long as it is, and the whole reason editing is safe to
              do here, is that the draft is not the zone -- so the person
              deciding whether to press Cancel needs to know that BEFORE they
              have spent ten minutes drawing. */}
          <p className="text-[11px] leading-snug text-muted-foreground">
            <span className="font-medium text-foreground">
              {editing ? "Nothing is changed until you press Save." : "Nothing is created until you press Create zone."}
            </span>{" "}
            The name, the area, every camera, every shape and every target are
            sent as one request and applied together — or not at all. Cancel at
            any point and {editing ? "the zone is left exactly as it is" : "nothing is left behind"}.
          </p>
          <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {stage === "place" && (problem ?? `${picked.length} camera${picked.length === 1 ? "" : "s"}`)}
            {stage === "draw" &&
              (waiting.length === 0
                ? "Every camera is positioned."
                : `${waiting.length} of ${picked.length} still to draw — undrawn shapes are recorded but never alerted on.`)}
            {stage === "policy" && (problem ?? `${targets.length} target${targets.length === 1 ? "" : "s"}`)}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {stageIndex > 0 && (
              <Button
                variant="outline"
                onClick={() => store.setStage(STAGES[stageIndex - 1]!)}
              >
                <ChevronLeftIcon className="size-4" /> Back
              </Button>
            )}
            {stageIndex < STAGES.length - 1 ? (
              <Button
                disabled={!canAdvance}
                onClick={() => store.setStage(STAGES[stageIndex + 1]!)}
              >
                Next <ChevronRightIcon className="size-4" />
              </Button>
            ) : (
              <Button onClick={save} disabled={Boolean(problem) || saving}>
                {saving
                  ? editing ? "Saving…" : "Creating…"
                  : editing ? "Save zone" : "Create zone"}
              </Button>
            )}
          </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────── stage 1

function PlaceStage({
  areas, cameras, nameOf, heldBy, pickedIds,
}: {
  areas: string[];
  cameras: Array<{ id: string; name: string }>;
  nameOf: Map<string, string>;
  heldBy: Map<string, string>;
  pickedIds: string[];
}) {
  const store = useWizardStore();
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return cameras;
    return cameras.filter(
      (camera) =>
        camera.name.toLowerCase().includes(needle) || camera.id.toLowerCase().includes(needle),
    );
  }, [cameras, query]);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="zone-name">Name</FieldLabel>
          <Input
            id="zone-name"
            value={store.name}
            onChange={(event) => store.setName(event.target.value)}
            placeholder="Fence line north"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="zone-kind">Kind of place</FieldLabel>
          <Select value={store.kind} onValueChange={(value) => store.setKind(value as ZoneKind)}>
            <SelectTrigger id="zone-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((option) => (
                <SelectItem key={option} value={option}>
                  {humanise(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field>
        <FieldLabel>Area</FieldLabel>
        <FieldDescription>
          A label grouping zones on the same stretch of ground. Type to filter, or
          type a new one. Optional.
        </FieldDescription>
        <AreaPicker areas={areas} value={store.area} onChange={store.setArea} />
      </Field>

      <Separator />

      <Field>
        <FieldLabel>Cameras</FieldLabel>
        <FieldDescription>
          Pick the cameras this zone is watched from. Click one to see where it
          stands and what it is pointed at.
        </FieldDescription>

        <div className="relative pt-1">
          <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name or id"
            className="pl-8"
          />
        </div>

        <div className="grid gap-1.5 pt-2">
          {matches.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
              No camera matches “{query}”.
            </p>
          )}
          {matches.map((camera) => {
            const held = heldBy.get(camera.id);
            const chosen = pickedIds.includes(camera.id);
            return (
              <div
                key={camera.id}
                onClick={() => {
                  store.focus(camera.id);
                  if (!held) store.toggleCamera(camera.id);
                }}
                className={cn(
                  "flex items-center gap-3 rounded-md border p-2.5 transition-colors",
                  held
                    ? "cursor-not-allowed opacity-60"
                    : chosen
                      ? "cursor-pointer border-primary/50 bg-accent"
                      : "cursor-pointer hover:bg-accent/50",
                )}
              >
                <Checkbox
                  disabled={Boolean(held)}
                  checked={chosen}
                  onCheckedChange={() => store.toggleCamera(camera.id)}
                  onClick={(event) => event.stopPropagation()}
                />
                <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{camera.name}</span>
                  {held && (
                    <span className="block text-xs text-muted-foreground">
                      already in {held} — a camera watches one zone
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </Field>
    </>
  );
}

// ───────────────────────────────────────────────────────────── stage 2

/**
 * The camera list for stage 2, one row per camera with its drawing state.
 *
 * Stage 2 is a list and not a forced march through N modals on purpose: a
 * supervisor who realises camera 3 is the wrong one should be able to go
 * straight back to it, not click Next past two shapes they are happy with.
 */
function DrawStage({ nameOf }: { nameOf: Map<string, string> }) {
  const store = useWizardStore();

  return (
    <Field>
      <FieldLabel>Cameras in this zone</FieldLabel>
      <FieldDescription>
        Pick one and draw it in the panel beside. A camera with no picture right
        now can be left — it joins on a placeholder, and the node records its
        crossings without alerting until somebody draws it.
      </FieldDescription>
      <div className="grid gap-1.5 pt-1">
        {store.cameras.map((camera) => {
          const drawn = camera.shape !== null && camera.shape.points.length > 0;
          const active = store.focused === camera.cameraId;
          return (
            <button
              key={camera.cameraId}
              type="button"
              onClick={() => store.focus(camera.cameraId)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md border p-2.5 text-left transition-colors",
                active ? "border-primary bg-accent" : "hover:bg-accent/50",
              )}
            >
              {drawn ? (
                <CheckIcon className="size-4 shrink-0 text-emerald-600" />
              ) : (
                <PencilIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">
                {nameOf.get(camera.cameraId) ?? camera.cameraId}
              </span>
              <Badge variant={drawn ? "secondary" : "outline"} className="shrink-0 font-normal">
                {drawn
                  ? `${camera.shape!.points.length} points · ${camera.shape!.geometry}`
                  : "not drawn"}
              </Badge>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/** The drawing surface, bound to whichever camera stage 2 has in hand. */
function DrawCanvas({ nameOf }: { nameOf: Map<string, string> }) {
  const store = useWizardStore();
  const current = store.cameras.find((camera) => camera.cameraId === store.focused);

  if (!current) {
    return (
      <p className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
        Pick a camera on the left to draw it.
      </p>
    );
  }

  const shape = current.shape ?? startingShape(store.kind);
  const problem = shapeProblem(shape);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">
          {nameOf.get(current.cameraId) ?? current.cameraId}
        </span>
        {problem ? (
          <span className="shrink-0 text-xs text-muted-foreground">{problem}</span>
        ) : (
          <Badge variant="secondary" className="shrink-0 gap-1 font-normal">
            <CheckIcon className="size-3" /> positioned
          </Badge>
        )}
      </div>

      <ShapeCanvas
        cameraId={current.cameraId}
        value={shape}
        // A shape only counts as drawn once it has enough points to be one.
        // Storing every intermediate click would tick the camera off after the
        // first point, and a one-point "line" is not a shape anybody drew.
        onChange={(next) =>
          store.setShape(current.cameraId, shapeProblem(next) === null ? next : { ...next })
        }
        revertTo={[]}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────── stage 3

function PolicyStage({ nameOf }: { nameOf: Map<string, string> }) {
  const store = useWizardStore();

  return (
    <>
      <Field>
        <FieldLabel>Detect against, in order of importance</FieldLabel>
        <FieldDescription>
          Animals are logged and never alerted on — that is what keeps a night
          from filling with cattle.
        </FieldDescription>
        <TargetEditor targets={store.targets} onChange={store.setTargets} />
      </Field>

      <Separator />

      <Field>
        <FieldLabel>Where a camera differs</FieldLabel>
        <FieldDescription>
          Every camera follows the policy above unless you say otherwise here. An
          exception replaces the zone's rule for that class on that camera only.
        </FieldDescription>
        <div className="grid gap-2 pt-1">
          {store.cameras.map((camera) => (
            <CameraException
              key={camera.cameraId}
              cameraId={camera.cameraId}
              label={nameOf.get(camera.cameraId) ?? camera.cameraId}
            />
          ))}
        </div>
      </Field>

      <Separator />

      <Field>
        <FieldLabel htmlFor="zone-reason">Reason for adding this</FieldLabel>
        <FieldDescription>Recorded against your name in the audit log.</FieldDescription>
        <Input
          id="zone-reason"
          value={store.reason}
          onChange={(event) => store.setReason(event.target.value)}
          placeholder="e.g. new coverage after the fence rebuild"
        />
      </Field>
    </>
  );
}

/** One camera's exceptions, collapsed until somebody wants them. */
function CameraException({ cameraId, label }: { cameraId: string; label: string }) {
  const store = useWizardStore();
  const camera = store.cameras.find((entry) => entry.cameraId === cameraId);
  const overrides = camera?.targets ?? null;

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-3 p-2.5">
        <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
        {overrides ? (
          <Button
            size="sm"
            variant="ghost"
            // Clearing puts the camera back on the zone policy. That is the
            // only way to undo an exception, so it is a button and not a
            // question of emptying the list -- an empty override list and no
            // override list mean different things to the node.
            onClick={() => store.setCameraTargets(cameraId, null)}
          >
            Follow the zone
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => store.setCameraTargets(cameraId, store.targets.map((t) => ({ ...t })))}
          >
            Differs here
          </Button>
        )}
      </div>
      {overrides && (
        <div className="border-t p-2.5">
          <TargetEditor
            targets={overrides}
            onChange={(next) => store.setCameraTargets(cameraId, next)}
          />
        </div>
      )}
    </div>
  );
}
