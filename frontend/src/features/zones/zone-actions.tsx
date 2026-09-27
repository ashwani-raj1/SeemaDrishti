import { useState } from "react";
import { PencilIcon, PowerIcon, PowerOffIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/ibvap/reason-dialog";
import { api, isForbidden } from "@/lib/api";
import type { MonitoringZone } from "@/lib/types";
import { NewZoneDialog } from "./new-zone-dialog";

/**
 * The zone-level actions on a zone's card: edit, and take out of service.
 *
 * EDIT OPENS THE WIZARD THAT CREATED THE ZONE, rather than a dialog of its own.
 * This file used to hold a small name-and-kind editor, and the card held four
 * more editors beside it -- a target list, a redraw button per camera, a
 * per-camera exception editor, add and remove camera -- each writing through
 * its own endpoint the moment it was touched. Creating a zone was one guided
 * flow; changing one was a scavenger hunt across five controls that applied
 * piecemeal, so a supervisor halfway through rearranging a zone had already
 * half-applied it. Editing now goes through the same three stages as creation
 * and lands as one atomic `PUT /api/zones/:id`.
 *
 * THE EDIT TRIGGER LIVES HERE, beside Deactivate, and that is deliberate after
 * getting it wrong once: it was briefly removed from this file on the
 * assumption the card header carried it, and the card header did not -- which
 * left a zone with no way to edit it at all. One file owns the zone-level
 * actions, so there is one place to look and nothing to keep in step.
 *
 * DEACTIVATE, NOT DELETE. `DELETE /api/zones/:id` is a soft delete by design:
 * past events still name the zone, and `event.zone_id` carries no foreign key
 * precisely so a zone can go away underneath a record that mentions it. So the
 * button says what actually happens rather than promising a removal the
 * database will not perform. A deactivated zone stops being judged within one
 * zone-refresh interval and its cameras are released to join another.
 */
export function ZoneActions({
  zone,
  canEdit,
  onChanged,
}: {
  zone: MonitoringZone;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!canEdit) return null;

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
        {/* The wizard, opened on this zone. `onCreated` fires for a save the
            same as for a create, so the card reloads either way. */}
        <NewZoneDialog
          zone={zone}
          canEdit={canEdit}
          onCreated={onChanged}
          trigger={
            <Button size="sm" variant="outline">
              <PencilIcon className="size-4" />
              Edit
            </Button>
          }
        />

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
