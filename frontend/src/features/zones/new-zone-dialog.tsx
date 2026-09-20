import { useMemo, useState } from "react";
import { CctvIcon, MapPinnedIcon, PlusIcon } from "lucide-react";
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
import { ATTARI_SECTOR, camerasInSector } from "@/client/geography";
import { api, isConflict, isForbidden } from "@/lib/api";
import { humanise } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MonitoringZone, ZoneKind } from "@/lib/types";
import { AreaPreview } from "./area-preview";
import { TargetEditor, type DraftTarget } from "./target-editor";

/**
 * Creating a monitoring zone.
 *
 * The order follows how somebody actually thinks about it: which stretch of
 * ground, then which cameras cover it, then what matters there. The area is
 * shown on the map beside the list the whole time, because "fence line north"
 * is a name until you can see which ground it means.
 *
 * Cameras join with a placeholder shape. Positioning each one against its own
 * view is a separate, separately-recorded act -- a zone should never go live
 * looking as though somebody has already checked it.
 */

const KINDS: ZoneKind[] = [
  "fence_line", "gate", "waterline", "perimeter", "pass", "restricted_area",
];

/** A sensible opening policy, so the list is never empty on arrival. */
const STARTING_TARGETS: DraftTarget[] = [
  { class: "person", severity: "CRITICAL", action: "alert" },
  { class: "vehicle", severity: "WARNING", action: "alert" },
  { class: "cattle", severity: "INFO", action: "log_only" },
];

export function NewZoneDialog({
  onCreated,
  canEdit,
}: {
  onCreated: (zone: MonitoringZone) => void;
  canEdit: boolean;
}) {
  const { cameras } = useClient();
  const [open, setOpen] = useState(false);
  const [sectorId, setSectorId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  /** Once typed into, the name stops following the chosen area. */
  const [nameEdited, setNameEdited] = useState(false);
  const [kind, setKind] = useState<ZoneKind>("fence_line");
  const [targets, setTargets] = useState<DraftTarget[]>(STARTING_TARGETS);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const sector = ATTARI_SECTOR.sectors.find((s) => s.id === sectorId) ?? null;
  const inArea = useMemo(() => (sectorId ? camerasInSector(sectorId) : []), [sectorId]);

  const nameOf = useMemo(() => new Map(cameras.map((c) => [c.id, c.name])), [cameras]);

  // A camera belongs to exactly one zone, so one that is already spoken for
  // cannot join this one. Shown disabled with the holder named rather than
  // filtered away -- the same reasoning as the unsurveyed-position note below,
  // where hiding the camera was itself the bug.
  const heldBy = useMemo(
    () => new Map(cameras.flatMap((c) => {
      const zone = c.zones.find((z) => z.active);
      return zone ? ([[c.id, zone.name]] as Array<[string, string]>) : [];
    })),
    [cameras],
  );

  /**
   * Cameras an area does NOT account for.
   *
   * `camerasInSector` matches on surveyed position in client/geography.ts, so a
   * camera nobody has surveyed belongs to no area. It was therefore impossible
   * to put in a zone at all -- you could add the camera, watch it, and never be
   * able to judge anything on it. A zone needs a camera and a shape, not a
   * grid reference, so position is a convenience here and never a requirement.
   */
  const elsewhere = useMemo(
    () => cameras.filter((camera) => !inArea.includes(camera.id)),
    [cameras, inArea],
  );

  function reset() {
    setSectorId(null);
    setPicked([]);
    setName("");
    setNameEdited(false);
    setKind("fence_line");
    setTargets(STARTING_TARGETS);
    setReason("");
  }

  /**
   * Choosing an area proposes its cameras; you can then untick any of them.
   *
   * The name follows the area until somebody types their own. Keeping a name
   * that was auto-filled from a different area is how a zone ends up called
   * "Fence line north" while watching the waterline.
   */
  function chooseSector(id: string) {
    setSectorId(id);
    setPicked(camerasInSector(id));

    const label = ATTARI_SECTOR.sectors.find((s) => s.id === id)?.label ?? "";
    if (!nameEdited) setName(label);
  }

  const toggle = (cameraId: string) =>
    setPicked((current) =>
      current.includes(cameraId)
        ? current.filter((id) => id !== cameraId)
        : [...current, cameraId],
    );

  const problem =
    picked.length === 0 ? "Pick at least one camera."
    : !name.trim() ? "Give the zone a name."
    : targets.length === 0 ? "Add at least one thing to detect against."
    : null;

  async function create() {
    if (problem) return;
    setSaving(true);
    try {
      const zone = await api.createZone({
        name: name.trim(),
        kind,
        sector: sectorId,
        cameraIds: picked,
        targets,
        reason: reason.trim() || undefined,
      });
      toast.success(`${zone.name} created`, {
        description: `${zone.cameras.length} camera${zone.cameras.length === 1 ? "" : "s"} — position each shape next.`,
      });
      onCreated(zone);
      setOpen(false);
      reset();
    } catch (error) {
      if (isConflict(error)) {
        // Nothing was created: the node rejects the whole call rather than
        // making the zone minus the offending camera, which would report
        // success while leaving a camera the supervisor believes is covered
        // watching nothing.
        toast.error("A camera you picked is already in another zone", {
          description: `${error.message} Nothing was created.`,
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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={!canEdit} title={canEdit ? undefined : "Needs a supervisor"}>
          <PlusIcon className="size-4" />
          New zone
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-6xl gap-0 p-0 sm:max-w-6xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>New monitoring zone</DialogTitle>
          <DialogDescription>
            Pick the ground, choose the cameras that cover it, then say what matters there.
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[70vh] gap-0 overflow-hidden lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          {/* ---------------------------------------------------- choices */}
          <ScrollArea className="max-h-[70vh]">
            <div className="space-y-5 p-5">
              <Field>
                <FieldLabel>Area</FieldLabel>
                <FieldDescription>
                  Cameras are matched to an area by where they stand, so this list cannot go stale.
                </FieldDescription>
                <div className="grid gap-1.5 pt-1">
                  {ATTARI_SECTOR.sectors.map((option) => {
                    const covering = camerasInSector(option.id);
                    const chosen = option.id === sectorId;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => chooseSector(option.id)}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors",
                          chosen ? "border-primary bg-accent" : "hover:bg-accent/50",
                        )}
                      >
                        <MapPinnedIcon
                          className={cn(
                            "mt-0.5 size-4 shrink-0",
                            chosen ? "text-primary" : "text-muted-foreground",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-medium">{option.label}</span>
                            <Badge variant="secondary" className="font-normal">
                              {covering.length} camera{covering.length === 1 ? "" : "s"}
                            </Badge>
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Field>

              {sector && (
                <>
                  <Separator />
                  <Field>
                    <FieldLabel>Cameras in {sector.label}</FieldLabel>
                    <FieldDescription>
                      Each one joins with a placeholder shape you position afterwards.
                    </FieldDescription>
                    <div className="grid gap-1.5 pt-1">
                      {inArea.length === 0 && (
                        <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                          No cameras stand in this area.
                        </p>
                      )}
                      {inArea.map((cameraId) => {
                        const held = heldBy.get(cameraId);
                        return (
                          <label
                            key={cameraId}
                            className={cn(
                              "flex items-center gap-3 rounded-md border p-2.5 transition-colors",
                              held
                                ? "cursor-not-allowed opacity-60"
                                : picked.includes(cameraId)
                                  ? "cursor-pointer border-primary/50 bg-accent"
                                  : "cursor-pointer hover:bg-accent/50",
                            )}
                          >
                            <Checkbox
                              disabled={Boolean(held)}
                              checked={picked.includes(cameraId)}
                              onCheckedChange={() => toggle(cameraId)}
                            />
                            <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">
                                {nameOf.get(cameraId) ?? cameraId}
                              </span>
                              {held && (
                                <span className="block text-xs text-muted-foreground">
                                  already in {held} — a camera watches one zone
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </Field>

                  <Separator />

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="zone-name">Name</FieldLabel>
                      <Input
                        id="zone-name"
                        value={name}
                        onChange={(event) => {
                          setName(event.target.value);
                          setNameEdited(true);
                        }}
                        placeholder="Fence line north"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="zone-kind">Kind of place</FieldLabel>
                      <Select value={kind} onValueChange={(value) => setKind(value as ZoneKind)}>
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
                    <FieldLabel>Detect against, in order of importance</FieldLabel>
                    <FieldDescription>
                      Animals are logged and never alerted on — that is what keeps a night from
                      filling with cattle.
                    </FieldDescription>
                    <TargetEditor targets={targets} onChange={setTargets} />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="zone-reason">Reason for adding this</FieldLabel>
                    <FieldDescription>Recorded against your name in the audit log.</FieldDescription>
                    <Input
                      id="zone-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="e.g. new coverage after the fence rebuild"
                    />
                  </Field>
                </>
              )}

              <Separator />
              <Field>
                <FieldLabel>
                  {sector ? "Other cameras" : "Cameras"}
                </FieldLabel>
                <FieldDescription>
                  {sector
                    ? "Not standing in that area, but you can still watch them from this zone."
                    : "Pick the cameras this zone is watched from. Choosing an area above just ticks the ones standing in it."}
                </FieldDescription>
                <div className="grid gap-1.5 pt-1">
                  {elsewhere.length === 0 && (
                    <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                      Every camera is accounted for by the area above.
                    </p>
                  )}
                  {elsewhere.map((camera) => {
                    const held = heldBy.get(camera.id);
                    return (
                    <label
                      key={camera.id}
                      className={cn(
                        "flex items-center gap-3 rounded-md border p-2.5 transition-colors",
                        held
                          ? "cursor-not-allowed opacity-60"
                          : picked.includes(camera.id)
                            ? "cursor-pointer border-primary/50 bg-accent"
                            : "cursor-pointer hover:bg-accent/50",
                      )}
                    >
                      <Checkbox
                        disabled={Boolean(held)}
                        checked={picked.includes(camera.id)}
                        onCheckedChange={() => toggle(camera.id)}
                      />
                      <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{camera.name}</span>
                        {held && (
                          <span className="block text-xs text-muted-foreground">
                            already in {held} — a camera watches one zone
                          </span>
                        )}
                        {!ATTARI_SECTOR.cameras[camera.id] && (
                          // Said plainly. The zone will work; only the map
                          // placement is missing, and guessing one would draw
                          // coverage over ground nobody can see.
                          <span className="block text-xs text-muted-foreground">
                            no surveyed position — it will not appear on the map
                          </span>
                        )}
                      </span>
                    </label>
                    );
                  })}
                </div>
              </Field>
            </div>
          </ScrollArea>

          {/* ---------------------------------------------------- preview */}
          <div className="hidden min-h-[420px] border-l bg-muted/30 p-4 lg:block">
            <AreaPreview
              area={sector?.area ?? []}
              inArea={inArea}
              selected={picked}
              onToggle={toggle}
              className="size-full min-h-[400px]"
            />
          </div>
        </div>

        <DialogFooter className="items-center gap-3 border-t px-5 py-3 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {problem ?? `${picked.length} camera${picked.length === 1 ? "" : "s"} · ${targets.length} target${targets.length === 1 ? "" : "s"}`}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={Boolean(problem) || saving}>
              {saving ? "Creating…" : "Create zone"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
