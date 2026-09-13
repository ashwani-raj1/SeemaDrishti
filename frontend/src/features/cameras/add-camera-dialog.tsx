import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CctvIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ibvap/spinner";
import { api, isForbidden } from "@/lib/api";
import type { HubCamera } from "@/lib/types";

/**
 * Adding a camera, as an action rather than as a consequence of an error.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE RED BANNER: the banner only appears when
 * the hub is already serving a path the node does not know, which is a state
 * you reach by accident. Somebody deliberately adding a camera has nothing to
 * click, and the flow is not guessable -- it spans a YAML file, a generator
 * script, a hub restart and only then this node.
 *
 * TWO WAYS IN, because there are genuinely two situations:
 *
 *   adopt     the hub is serving a path the node has never heard of. One
 *             click; the id is taken from the hub verbatim.
 *   register  the hub is not serving it yet. Useful when the manifest is
 *             already agreed and the camera is being commissioned -- the row
 *             sits there showing "no feed" until video arrives, which is an
 *             honest state and not a failure.
 *
 * THE ID IS NOT COSMETIC AND THE DIALOG SAYS SO. It is the hub path, the RTSP
 * URL and the `camera_id` on every detection. A mismatch produces a camera
 * that looks perfectly healthy and silently discards everything it sees, which
 * is the worst failure this console can have.
 */

const ID_RULE = /^[A-Za-z0-9_-]+$/;

export function AddCameraDialog({
  unseeded,
  canEdit,
  onAdded,
}: {
  /** Hub paths the node does not know yet — the one-click cases. */
  unseeded: HubCamera[];
  canEdit: boolean;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setId("");
      setName("");
    }
  }, [open]);

  const problem =
    !id.trim()
      ? "The id must match the hub's path name exactly."
      : !ID_RULE.test(id.trim())
        ? "Letters, digits, underscore and hyphen only."
        : null;

  async function add(cameraId: string, cameraName: string) {
    setSaving(true);
    try {
      await api.createCamera({
        id: cameraId,
        name: cameraName || cameraId,
        reason: "added from the cameras page",
      });
      toast.success(`${cameraName || cameraId} registered`, {
        description: "Detections from this camera are now accepted and can open incidents.",
      });
      onAdded();
      setOpen(false);
    } catch (error) {
      toast.error(
        isForbidden(error) ? "This needs a supervisor." : (error as Error).message,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={!canEdit}>
          <PlusIcon className="size-3.5" />
          Add camera
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a camera</DialogTitle>
          <DialogDescription>
            The media hub serves the video; the node has to know the camera
            before it will accept anything detected on it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {unseeded.length > 0 ? (
            <div className="flex flex-col gap-2">
              <Label>Serving on the hub, unknown to the node</Label>
              <p className="text-xs text-muted-foreground">
                One click. The id comes from the hub, so it cannot be mistyped.
              </p>
              {unseeded.map((camera) => (
                <div
                  key={camera.id}
                  className="flex items-center gap-3 rounded-md border p-3"
                >
                  <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{camera.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {camera.id}
                    </span>
                  </span>
                  {camera.ready && (
                    <Badge variant="secondary" className="shrink-0">serving</Badge>
                  )}
                  <Button
                    size="sm"
                    disabled={saving}
                    onClick={() => void add(camera.id, camera.name)}
                  >
                    Add
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>The hub is not serving anything new</AlertTitle>
              <AlertDescription>
                Every path the hub publishes is already registered. To add a new
                camera, declare it on the hub first:
                <ol className="ml-4 list-decimal text-xs">
                  <li>
                    Add a block to <code className="font-mono">media/cameras.yml</code>
                  </li>
                  <li>
                    Run <code className="font-mono">python media/configure.py</code>
                  </li>
                  <li>Restart the hub, then reopen this dialog</li>
                </ol>
                <span className="text-xs">
                  Full steps in <code className="font-mono">docs/ADDING_A_CAMERA.md</code>.
                </span>
              </AlertDescription>
            </Alert>
          )}

          <Separator />

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="camera-id">Or register one by id</Label>
              <p className="text-xs text-muted-foreground">
                For a camera being commissioned. It will show{" "}
                <strong>no feed</strong> until the hub starts serving that path —
                an honest state, not a fault.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="camera-id" className="text-xs">
                  Hub path / id
                </Label>
                <Input
                  id="camera-id"
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  placeholder="cam_south_gate"
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="camera-name" className="text-xs">
                  Display name
                </Label>
                <Input
                  id="camera-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="BOP-06 South Gate"
                />
              </div>
            </div>

            {/* The one mistake that produces a camera which looks fine and
                records nothing. Worth saying at the point of typing it. */}
            <p className="text-xs text-muted-foreground">
              This id must be identical to the path in{" "}
              <code className="font-mono">media/cameras.yml</code>. If they
              differ, video will play and every detection will be rejected.
            </p>
          </div>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">{problem}</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={Boolean(problem) || saving}
              onClick={() => void add(id.trim(), name.trim())}
            >
              {saving && <Spinner />} Register
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
