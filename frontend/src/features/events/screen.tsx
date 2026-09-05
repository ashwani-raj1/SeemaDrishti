import { useCallback, useState } from "react";
import { ScrollTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageShell } from "@/components/ibvap/page-shell";
import { EventTable } from "@/components/ibvap/event-table";
import { ErrorState, LoadingRows, NothingHere } from "@/components/ibvap/states";
import { useClient } from "@/client/context";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

const ALL = "__all__";

/** Every fact the node kept, including the ones it deliberately never raised. */
export function EventLogScreen() {
  const { cameras } = useClient();
  const [cameraId, setCameraId] = useState(ALL);
  const [severity, setSeverity] = useState(ALL);
  const [alertableOnly, setAlertableOnly] = useState(false);
  const [limit, setLimit] = useState(100);

  const load = useCallback(
    () =>
      api.events({
        camera_id: cameraId === ALL ? undefined : cameraId,
        severity: severity === ALL ? undefined : severity,
        alertable: alertableOnly || undefined,
        limit,
      }),
    [cameraId, severity, alertableOnly, limit],
  );

  const { data, error, loading, reload } = useResource(load, [cameraId, severity, alertableOnly, limit]);
  const suppressed = (data ?? []).filter((event) => !event.alertable).length;

  return (
    <PageShell
      title="Event log"
      description="An event is the first thing written to disk. The millions of per-frame observations beneath it are thrown away."
      actions={
        <Button variant="outline" size="sm" onClick={reload}>
          Refresh
        </Button>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-3">
          <Select value={cameraId} onValueChange={setCameraId}>
            <SelectTrigger size="sm" className="w-56">
              <SelectValue placeholder="All cameras" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All cameras</SelectItem>
                {cameras.map((camera) => (
                  <SelectItem key={camera.id} value={camera.id}>
                    {camera.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue placeholder="Any severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>Any severity</SelectItem>
                <SelectItem value="INFO">INFO</SelectItem>
                <SelectItem value="WARNING">WARNING</SelectItem>
                <SelectItem value="CRITICAL">CRITICAL</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <Switch id="alertable" checked={alertableOnly} onCheckedChange={setAlertableOnly} />
            <Label htmlFor="alertable" className="text-xs text-muted-foreground">
              Alertable only
            </Label>
          </div>

          {data && (
            <div className="ml-auto flex items-center gap-2">
              <Badge variant="outline" className="font-mono">
                {data.length} rows
              </Badge>
              {suppressed > 0 && (
                <Badge variant="secondary" className="font-mono">
                  {suppressed} suppressed
                </Badge>
              )}
            </div>
          )}
        </div>
      }
    >
      {loading && <LoadingRows />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && (
        <NothingHere
          icon={ScrollTextIcon}
          title="No events match"
          description="Nothing recorded for these filters. Run a scenario from the Simulator to generate some."
        />
      )}
      {data && data.length > 0 && (
        <>
          <EventTable events={data} showDate />
          {data.length >= limit && (
            <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + 100)}>
              Load more
            </Button>
          )}
        </>
      )}
    </PageShell>
  );
}
