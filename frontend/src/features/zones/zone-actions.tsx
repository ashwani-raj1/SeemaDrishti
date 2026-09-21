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
        {/* No Edit button here any more. Changing a zone -- its name, kind,
            area, cameras, shapes or targets -- happens in the wizard that
            created it, in one atomic call. What is left here is the pair that
            are NOT edits: taking the whole zone out of service and putting it
            back, each with its own confirmation and its own reason. */}
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
