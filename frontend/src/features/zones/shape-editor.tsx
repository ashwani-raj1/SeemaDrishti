import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ibvap/spinner";
import { api } from "@/lib/api";
import type { Direction, Point, ZoneGeometry } from "@/lib/types";
import { ShapeCanvas, shapeProblem, type ShapeDraft } from "./shape-canvas";

/**
 * Repositioning one camera's shape in a zone that already exists.
 *
 * The drawing itself lives in `ShapeCanvas` -- this is the half that turns a
 * drawing into a recorded decision: it demands a reason, PATCHes the node, and
 * tells the supervisor the detector will pick it up on its next refresh rather
 * than instantly.
 *
 * The wizard uses the same canvas with none of this, because a shape drawn for
 * a zone that does not exist yet is not a change to anything and there is
 * nothing to give a reason for until the whole zone is saved.
 */

export interface ShapeEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zoneId: string;
  zoneName: string;
  cameraId: string;
  cameraName: string;
  geometry: ZoneGeometry;
  points: Point[];
  direction: Direction | "both";
  confirmSeconds: number;
  onSaved: () => void;
}

export function ShapeEditor({
  open, onOpenChange, zoneId, zoneName, cameraId, cameraName,
  geometry, points, direction, confirmSeconds, onSaved,
}: ShapeEditorProps) {
  const [draft, setDraft] = useState<ShapeDraft>({
    geometry, points, direction, confirmSeconds,
  });
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset to the stored shape every time the dialog opens, so an abandoned
  // edit never leaks into the next one.
  useEffect(() => {
    if (!open) return;
    setDraft({ geometry, points, direction, confirmSeconds });
    setReason("");
  }, [open, geometry, points, direction, confirmSeconds]);

  const problem =
    shapeProblem(draft) ??
    (reason.trim().length < 3
      ? "Say why this shape is changing. It is recorded against your name."
      : null);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateZoneCamera(zoneId, cameraId, { ...draft, reason });
      toast.success("Zone shape saved", {
        description: `${zoneName} on ${cameraName} — the detector picks it up within its refresh interval.`,
      });
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {zoneName} · {cameraName}
          </DialogTitle>
          <DialogDescription>
            Click the picture to place points. Drag a point to move it. These are
            the exact coordinates the detector judges against.
          </DialogDescription>
        </DialogHeader>

        <ShapeCanvas
          cameraId={cameraId}
          value={draft}
          onChange={setDraft}
          revertTo={points}
          active={open}
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shape-reason">Reason for the change</Label>
          <Textarea
            id="shape-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. re-surveyed after the fence rebuild"
            rows={2}
          />
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">{problem}</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={save} disabled={Boolean(problem) || saving}>
              {saving && <Spinner />} Save shape
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
