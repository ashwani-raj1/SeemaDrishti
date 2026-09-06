import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CctvIcon, ExternalLinkIcon, SaveIcon } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { PageShell } from "@/components/ibvap/page-shell";
import { CameraStatusPill } from "@/components/ibvap/badges";
import { CameraMap } from "@/components/ibvap/camera-map";
import { ErrorState, LoadingRows } from "@/components/ibvap/states";
import { useClient } from "@/client/context";
import { api, isForbidden, needsReason } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { humanise } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CameraDetail } from "@/lib/types";
import { Link } from "react-router-dom";

/**
 * The feeds this site reads, and the settings a person controls.
 *
 * Two states live side by side and are deliberately not merged. The status
 * pill is OBSERVED -- the analysis engine writes what it can actually see, and
 * that is the blindness ladder. "In service" is DECIDED -- somebody turned the
 * feed off. An operator needs to tell those apart: one means send a patrol,
 * the other means we chose this.
 */
export function CamerasScreen() {
  const { role, refreshServer } = useClient();
  const [params] = useSearchParams();
  const wanted = params.get("camera");
  const cameras = useResource(() => api.cameras(), []);

  const canEdit = role !== "operator";

  const reload = () => {
    cameras.reload();
    void refreshServer();
  };

  return (
      <PageShell
        title="Cameras"
        description="Ordinary IP cameras over RTSP. No proprietary boxes, no smart hardware — that constraint is the project."
      >
        {cameras.loading && !cameras.data && <LoadingRows rows={3} />}
        {cameras.error && <ErrorState error={cameras.error} onRetry={cameras.reload} />}

        <div className="grid gap-4 xl:grid-cols-2">
          {cameras.data?.map((camera) => (
            <CameraCard
              key={camera.id}
              camera={camera}
              canEdit={canEdit}
              focused={camera.id === wanted}
              onSaved={reload}
            />
          ))}
        </div>
      </PageShell>
  );
}

function CameraCard({
  camera,
  canEdit,
  focused,
  onSaved,
}: {
  camera: CameraDetail;
  canEdit: boolean;
  focused?: boolean;
  onSaved: () => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const [name, setName] = useState(camera.name);
  const [streamUrl, setStreamUrl] = useState(camera.streamUrl ?? "");
  const [enabled, setEnabled] = useState(camera.enabled);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (focused) card.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focused]);

  useEffect(() => {
    setName(camera.name);
    setStreamUrl(camera.streamUrl ?? "");
    setEnabled(camera.enabled);
    setReason("");
  }, [camera]);

  const dirty =
    name !== camera.name ||
    streamUrl !== (camera.streamUrl ?? "") ||
    enabled !== camera.enabled;

  // Turning a feed off stops it being judged, so it has to be explained.
  const goingDark = camera.enabled && !enabled;

  async function save() {
    setSaving(true);
    try {
      await api.updateCamera(camera.id, {
        name: name.trim(),
        streamUrl: streamUrl.trim() || null,
        enabled,
        reason: reason.trim() || undefined,
      });
      toast.success(`${name.trim()} saved`);
      setReason("");
      onSaved();
    } catch (error) {
      toast.error(
        isForbidden(error)
          ? "Changing a camera needs a supervisor."
          : needsReason(error)
            ? "Say why this feed is being taken out of service."
            : (error as Error).message,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card ref={card} className={cn(focused && "ring-2 ring-primary")}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <CctvIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{camera.name}</span>
          <CameraStatusPill status={camera.status} className="ml-auto" />
          {!camera.enabled && <Badge variant="destructive">out of service</Badge>}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
          <span>{camera.id}</span>
          <span>
            {camera.incidents.total} incident{camera.incidents.total === 1 ? "" : "s"}
          </span>
          {camera.incidents.open > 0 && (
            <span className="text-amber-600 dark:text-amber-500">
              {camera.incidents.open} open
            </span>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <CameraMap camera={camera} className="aspect-video w-full" showSwitcher />

        <Button variant="outline" size="sm" className="w-full" asChild>
          <Link to={`/cameras/${camera.id}`}>
            <ExternalLinkIcon className="size-4" />
            Open this feed&rsquo;s record
          </Link>
        </Button>

        <Separator />

        <Field>
          <FieldLabel htmlFor={`name-${camera.id}`}>Name</FieldLabel>
          <FieldDescription>What operators call this feed on every screen.</FieldDescription>
          <Input
            id={`name-${camera.id}`}
            value={name}
            disabled={!canEdit}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={`stream-${camera.id}`}>Stream address</FieldLabel>
          <FieldDescription>
            The RTSP the node reads. Ordinary protocol, ordinary camera — leave it empty until the
            feed is cabled.
          </FieldDescription>
          <Input
            id={`stream-${camera.id}`}
            value={streamUrl}
            disabled={!canEdit}
            placeholder="rtsp://10.0.4.21:554/stream1"
            onChange={(event) => setStreamUrl(event.target.value)}
            className="font-mono text-xs"
          />
        </Field>

        <div className="flex items-start gap-3 rounded-md border p-3">
          <Switch
            id={`enabled-${camera.id}`}
            checked={enabled}
            disabled={!canEdit}
            onCheckedChange={setEnabled}
          />
          <div className="min-w-0 flex-1">
            <FieldLabel htmlFor={`enabled-${camera.id}`} className="cursor-pointer">
              In service
            </FieldLabel>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {enabled
                ? "Crossings on this feed are judged and raised."
                : "Detections still arrive, but nothing is judged and no incident is raised."}
            </p>
          </div>
        </div>

        {camera.zones.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">Zones drawn on this feed</p>
            {camera.zones.map((zone) => (
              <div key={zone.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="font-medium">{zone.name}</span>
                <Badge variant="outline" className="font-mono text-[10px] font-normal">
                  {humanise(zone.kind)}
                </Badge>
                <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                  {zone.direction}
                </Badge>
                {!zone.placed && (
                  <span className="text-[11px] text-amber-600 dark:text-amber-500">
                    shape not positioned
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {camera.zones.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No zones drawn on this feed, so it raises nothing.
          </p>
        )}

        {canEdit && dirty && (
          <div className="flex flex-col gap-3 rounded-md border bg-muted/40 p-3">
            <Field>
              <FieldLabel htmlFor={`reason-${camera.id}`}>
                Reason {goingDark && <span className="text-destructive">(required)</span>}
              </FieldLabel>
              <Input
                id={`reason-${camera.id}`}
                value={reason}
                placeholder={
                  goingDark ? "e.g. lens cracked, replacement on order" : "e.g. re-cabled to the new switch"
                }
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Button onClick={save} disabled={saving || (goingDark && !reason.trim())}>
              <SaveIcon className="size-4" />
              {saving ? "Saving…" : "Save camera"}
            </Button>
          </div>
        )}

        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            Changing a camera needs a supervisor. Switch actor in the header.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
