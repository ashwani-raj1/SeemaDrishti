import { useEffect } from "react";
import { EyeOffIcon, TriangleAlertIcon } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageShell } from "@/components/ibvap/page-shell";
import { CameraStatusPill } from "@/components/ibvap/badges";
import { NothingHere } from "@/components/ibvap/states";
import { useClient } from "@/client/context";
import { onStream } from "@/lib/stream";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { CAMERA_STATUS_ORDER } from "@/lib/types";

/**
 * What is up, what is degraded, what is blind right now (#22).
 *
 * Existing field systems lose capability silently during exactly the foggy
 * window infiltrators use. An operator who knows Camera 14 is blind can send a
 * foot patrol; an operator who does not, cannot. So the board exists to make
 * the loss loud.
 */
export function StatusBoardScreen() {
  const { cameras, refreshServer } = useClient();
  const health = useResource(() => api.health(), []);

  // A zone edit or a status change is pushed; take the node at its word.
  useEffect(() => onStream("camera", () => void refreshServer()), [refreshServer]);

  const blind = cameras.filter((camera) => camera.status !== "FULL");
  const worst = CAMERA_STATUS_ORDER.filter((status) =>
    cameras.some((camera) => camera.status === status),
  ).at(-1);

  return (
    <PageShell
      title="Status board"
      description="The blindness ladder. Degrading is never silent — every step is announced here, and in the shift summary."
    >
      {blind.length > 0 ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>
            {blind.length} of {cameras.length} cameras below full capability
          </AlertTitle>
          <AlertDescription>
            Worst current state is {worst}. Analysis is reduced on these feeds — consider a foot
            patrol for the ground they cover.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>All feeds at full capability</AlertTitle>
          <AlertDescription>
            Every camera is running the complete analysis path.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Cameras" value={String(cameras.length)} hint="on this site" />
        <Stat
          label="Live tracks"
          value={health.data ? String(health.data.liveTracks) : "—"}
          hint="held in memory, never written"
        />
        <Stat
          label="Screen subscribers"
          value={health.data ? String(health.data.streamSubscribers) : "—"}
          hint="browsers on the live push"
        />
      </div>

      {cameras.length === 0 ? (
        <NothingHere
          icon={EyeOffIcon}
          title="No cameras configured"
          description="This site has no feeds. Add one in the Cameras section."
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Camera</TableHead>
                <TableHead className="w-36">State</TableHead>
                <TableHead className="w-24 text-right">Zones</TableHead>
                <TableHead>Watching for</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cameras.map((camera) => (
                <TableRow key={camera.id}>
                  <TableCell className="font-medium">
                    {camera.name}
                    <span className="block font-mono text-xs text-muted-foreground">
                      {camera.id}
                    </span>
                  </TableCell>
                  <TableCell>
                    <CameraStatusPill status={camera.status} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {camera.zones.length}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {[...new Set(camera.zones.flatMap((zone) => zone.watchClasses))].map((cls) => (
                        <Badge key={cls} variant="secondary" className="font-mono text-xs">
                          {cls}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageShell>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
