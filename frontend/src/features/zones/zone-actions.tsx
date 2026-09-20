import { useState } from "react";
import { PencilIcon, PowerIcon, PowerOffIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ReasonDialog } from "@/components/ibvap/reason-dialog";
import { Spinner } from "@/components/ibvap/spinner";
import { api, isForbidden } from "@/lib/api";
import type { MonitoringZone, ZoneKind } from "@/lib/types";

/**
 * The two zone-level writes the console never offered.
 *
 * Both endpoints existed and were audited from the start; nothing called them,
 * so the only way to fix a typo in a zone's name was to delete it and rebuild
 * -- losing its id, and with it every event that points at it.
 *
 * DEACTIVATE, NOT DELETE. `DELETE /api/zones/:id` is a soft delete by design:
 * past events still name the zone, and `event.zone_id` carries no foreign key
 * precisely so a zone can go away underneath a record that mentions it. So the
 * button says what actually happens rather than promising a removal the
 * database will not perform. A deactivated zone stops being judged within one
 * zone-refresh interval and its cameras are released to join another.
 */

const KINDS: ZoneKind[] = [
  "fence_line", "gate", "waterline", "perimeter", "pass", "restricted_area",
];

const label = (kind: string) => kind.replace(/_/g, " ");

export function ZoneActions({
  zone,
  canEdit,
  onChanged,
}: {
  zone: MonitoringZone;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState(zone.name);
  const [kind, setKind] = useState<ZoneKind>(zone.kind);
  const [reason, setReason] = useState("");

  if (!canEdit) return null;

  const problem =
    !name.trim() ? "Give the zone a name."
    : reason.trim().length < 3 ? "Say why, in a few words."
    : null;

  async function run(work: () => Promise<unknown>, done: string, description?: string) {
    setBusy(true);
    try {
      await work();
      toast.success(done, description ? { description } : undefined);
      onChanged();
      return true;
    } catch (error) {
      toast.error(
        isForbidden(error) ? "This needs a supervisor." : (error as Error).message,
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            // Reset from the zone on open, so an abandoned edit never leaks
            // into the next one.
            setName(zone.name);
            setKind(zone.kind);
            setReason("");
            setEditing(true);
          }}
        >
          <PencilIcon className="size-4" />
          Edit
        </Button>

        {zone.active ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            <PowerOffIcon className="size-4" />
            Deactivate
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(
                () => api.updateZone(zone.id, { active: true, reason: "back in service" }),
                "Zone reactivated",
                "The detector picks it up within its refresh interval.",
              )
            }
          >
            <PowerIcon className="size-4" />
            Reactivate
          </Button>
        )}
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {zone.name}</DialogTitle>
            <DialogDescription>
              The zone keeps its id, its cameras, its shapes and its history —
              only what it is called and what kind of place it is change.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor={`name-${zone.id}`}>Name</FieldLabel>
              <Input
                id={`name-${zone.id}`}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={`kind-${zone.id}`}>Kind</FieldLabel>
              <Select value={kind} onValueChange={(value) => setKind(value as ZoneKind)}>
                <SelectTrigger id={`kind-${zone.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {KINDS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {label(option)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                A label, not behaviour — what a zone detects against is its
                targets. It only decides the placeholder shape a camera gets
                when it joins.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={`why-${zone.id}`}>Reason</FieldLabel>
              <Input
                id={`why-${zone.id}`}
                value={reason}
                placeholder="Why is this changing?"
                onChange={(event) => setReason(event.target.value)}
              />
              <FieldDescription>Recorded against your name in the audit log.</FieldDescription>
            </Field>
          </div>

          <DialogFooter className="items-center gap-2">
            {problem && <span className="mr-auto text-sm text-muted-foreground">{problem}</span>}
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              disabled={Boolean(problem) || busy}
              onClick={async () => {
                const ok = await run(
                  () =>
                    api.updateZone(zone.id, {
                      name: name.trim(),
                      kind,
                      reason: reason.trim(),
                    }),
                  "Zone updated",
                );
                if (ok) setEditing(false);
              }}
            >
              {busy && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReasonDialog
        open={confirming}
        title={`Deactivate ${zone.name}?`}
        description={
          "It stops being judged within one zone-refresh interval, and its " +
          `${zone.cameras.filter((c) => c.active).length} camera(s) are released to join another zone. ` +
          "Nothing is deleted: every event that named this zone still names it, " +
          "and you can reactivate it here."
        }
        confirmLabel="Deactivate"
        destructive
        pending={busy}
        onOpenChange={setConfirming}
        onConfirm={async (why) => {
          const ok = await run(
            () => api.deleteZone(zone.id, why),
            "Zone deactivated",
            "Its cameras are free to join another zone.",
          );
          if (ok) setConfirming(false);
        }}
      />
    </>
  );
}
