import { Link } from "react-router-dom";
import { CctvIcon, PlusIcon, SettingsIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageShell } from "@/components/ibvap/page-shell";
import { CameraFeed } from "@/components/ibvap/camera-feed";
import { CameraStatusPill } from "@/components/ibvap/badges";
import { ErrorState, LoadingRows, NothingHere } from "@/components/ibvap/states";
import { useClient } from "@/client/context";
import { api, isForbidden } from "@/lib/api";
import { relative } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { HubCamera } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AddCameraDialog } from "./add-camera-dialog";

/**
 * The feeds this site has, as the media hub is actually serving them.
 *
 * THE LIST COMES FROM THE HUB, NOT FROM A CONFIG FILE. A camera appears here
 * when it starts publishing and is marked dead when it stops, so this page
 * cannot show a tidy row for a feed nobody is sending. That is the difference
 * between a console that reports the system and one that reports its own
 * settings.
 *
 * THREE FACTS PER CAMERA, NEVER MERGED, because each sends a different person
 * to do a different thing:
 *
 *   serving   is the hub publishing frames at all
 *   status    what the vision service can make of them (the blindness ladder)
 *   enabled   whether a human took this feed out of service on purpose
 *
 * And a fourth that only shows when it is wrong: `seeded`. A path the hub
 * serves but the node has never heard of accepts no detections and can open no
 * incident, while looking perfectly healthy on screen. It is the one failure
 * here that is invisible without being named.
 */
export function CamerasScreen() {
  const { role, media, refreshServer } = useClient();
  const hub = useResource(() => api.mediaCameras(), []);
  const canEdit = role !== "operator";

  const reload = () => {
    hub.reload();
    void refreshServer();
  };

  const toggle = async (camera: HubCamera, enabled: boolean) => {
    try {
      await api.updateCamera(camera.id, { enabled });
      toast.success(
        enabled ? `${camera.name} back in service` : `${camera.name} taken out of service`,
      );
      reload();
    } catch (error) {
      toast.error(
        isForbidden(error) ? "This needs a supervisor." : (error as Error).message,
      );
    }
  };

  /**
   * Register a camera the hub is already serving.
   *
   * The id is the hub's path name, passed through untouched: the vision
   * service stamps that exact string on every detection and the node matches
   * on it, so generating a new one here would guarantee they never agree.
   */
  const adopt = async (camera: HubCamera) => {
    try {
      await api.createCamera({
        id: camera.id,
        name: camera.name,
        reason: "adopted from the media hub",
      });
      toast.success(`${camera.name} registered`, {
        description: "Detections from this camera are now accepted and can open incidents.",
      });
      reload();
    } catch (error) {
      toast.error(
        isForbidden(error) ? "This needs a supervisor." : (error as Error).message,
      );
    }
  };

  const cameras = hub.data?.cameras ?? [];

  return (
    <PageShell
      title="Cameras"
      description="Every feed the media hub is serving, and what the node knows about it."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload}>
            Refresh
          </Button>
          <AddCameraDialog
            unseeded={cameras.filter((camera) => !camera.seeded)}
            canEdit={canEdit}
            onAdded={reload}
          />
        </div>
      }
    >
      {hub.error && <ErrorState error={hub.error} onRetry={hub.reload} />}

      {hub.data && !hub.data.hub.reachable && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>The media hub is not answering</AlertTitle>
          <AlertDescription>
            {hub.data.hub.url} — {hub.data.hub.error}. The cameras below are the
            ones the node has on record; nothing is being checked against a live
            feed, and no preview will load.
          </AlertDescription>
        </Alert>
      )}

      {hub.loading && <LoadingRows rows={4} />}

      {!hub.loading && cameras.length === 0 && (
        <NothingHere
          icon={CctvIcon}
          title="No cameras"
          description="The hub is serving nothing and the node has none on record. Add a block to media/cameras.yml, then run media/configure.py."
        />
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cameras.map((camera) => (
          <Card key={camera.id} className={cn(camera.enabled === false && "opacity-70")}>
            <CardHeader className="flex-row items-start justify-between gap-2 space-y-0 pb-3">
              <div className="flex min-w-0 flex-col gap-1">
                <CardTitle className="truncate text-sm font-medium">
                  {camera.name}
                </CardTitle>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {camera.id}
                </span>
              </div>
              {camera.status && <CameraStatusPill status={camera.status} />}
            </CardHeader>

            <CardContent className="flex flex-col gap-3">
              <CameraFeed
                cameraId={camera.id}
                whepBase={media?.whepBase}
                module={null}
                showBoxes={false}
              />

              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={camera.ready ? "secondary" : "destructive"}>
                  {camera.ready ? "serving" : "no feed"}
                </Badge>
                {camera.width && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {camera.width}×{camera.height} {camera.codec}
                  </Badge>
                )}
                {camera.readySince && (
                  <span className="text-xs text-muted-foreground">
                    up {relative(camera.readySince)}
                  </span>
                )}
              </div>

              {!camera.seeded && (
                <div className="flex flex-col gap-2 rounded-md bg-destructive/10 p-2">
                  <p className="text-xs text-destructive">
                    The hub serves this path but the node has no such camera, so
                    every detection from it is rejected and no incident can open.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!canEdit}
                    onClick={() => void adopt(camera)}
                  >
                    <PlusIcon className="size-3.5" />
                    {canEdit ? "Add to the node" : "A supervisor must add this"}
                  </Button>
                </div>
              )}

              <div className="flex items-center justify-between gap-2 border-t pt-3">
                {camera.seeded ? (
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`enabled-${camera.id}`}
                      checked={camera.enabled !== false}
                      disabled={!canEdit}
                      onCheckedChange={(next) => void toggle(camera, next)}
                    />
                    {/* "In service" is a DECISION, kept apart from the status
                        pill above, which is OBSERVED. Merging them would make
                        "we are blind" look like "we chose to stop looking". */}
                    <Label htmlFor={`enabled-${camera.id}`} className="text-xs">
                      In service
                    </Label>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">not configurable</span>
                )}
                {camera.seeded && (
                  <Button asChild size="sm" variant="ghost">
                    <Link to={`/cameras/${camera.id}`}>
                      <SettingsIcon className="size-3.5" /> Settings
                    </Link>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
