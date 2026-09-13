import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingRows } from "@/components/ibvap/states";
import { SeverityBadge, SimulatedBadge } from "@/components/ibvap/badges";
import { api } from "@/lib/api";
import { onStream } from "@/lib/stream";
import { relative } from "@/lib/format";
import type { PlateDetection } from "@/lib/types";
import { ServiceShell } from "./service-shell";

/**
 * Number plates, read inside a tracked vehicle box.
 *
 * TWO KINDS OF PLATE ON THIS PAGE, AND THEY MUST NOT BE CONFUSED:
 *
 *   live console   what the OCR is guessing this second. Unconfirmed, never
 *                  stored, drawn amber on the video. It may be wrong, it may
 *                  flicker between readings, and nothing may be done about it.
 *   accepted reads the table below. These passed the plausibility gate, were
 *                  posted to the node, checked against the watchlist and
 *                  written down. This is the record.
 *
 * The gap between them is deliberate and is the reason a bumper sticker never
 * becomes a watchlist hit: a read is accepted only at 6-12 characters, above
 * the confidence floor, containing both a letter and a digit.
 *
 * ANPR runs only on cameras whose manifest block enables it, because plate
 * reading is resolution-bound -- it works where plates face the camera at a
 * gate or checkpoint, not across open ground.
 */
export function AnprScreen() {
  return (
    <ServiceShell
      title="Number plates"
      description="Plate text read inside tracked vehicle boxes, then checked against the watchlist."
      module="anpr"
      eventKinds={["plate_detection"]}
      emptyHint="No camera is serving. ANPR also needs `anpr` in the camera's modules list in media/cameras.yml."
    >
      {(camera) => <AcceptedReads cameraId={camera.id} />}
    </ServiceShell>
  );
}

function AcceptedReads({ cameraId }: { cameraId: string }) {
  const [reads, setReads] = useState<PlateDetection[] | null>(null);

  const load = useCallback(async () => {
    setReads(await api.plateDetections({ camera_id: cameraId, limit: 25 }));
  }, [cameraId]);

  useEffect(() => {
    setReads(null);
    void load();
  }, [load]);

  // The node pushes a plate_detection frame when one is written. Listening
  // beats polling: a read that arrives while an operator is watching should
  // appear as it happens, not up to fifteen seconds later.
  useEffect(() => onStream("plate_detection", () => void load()), [load]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-sm font-medium">Accepted reads</CardTitle>
          <p className="text-xs text-muted-foreground">
            Recorded by the edge node. The live console above shows unconfirmed
            guesses; these are the ones that were kept.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/watchlist">Watchlist</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {reads === null && <LoadingRows rows={4} />}
        {reads?.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No plate has been read on this camera yet.
          </p>
        )}
        {reads && reads.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plate</TableHead>
                <TableHead>Vehicle</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Match</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reads.map((read) => (
                <TableRow key={read.id}>
                  <TableCell className="font-mono font-medium">
                    {read.plate_number}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {read.vehicle_type}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums text-muted-foreground">
                    {(read.plate_confidence * 100).toFixed(0)}%
                  </TableCell>
                  <TableCell>
                    {read.match_status === "MATCHED" ? (
                      <SeverityBadge severity={read.severity} />
                    ) : (
                      <Badge variant="outline" className="text-[10px]">CLEAR</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    <span className="flex items-center justify-end gap-2">
                      {read.simulated && <SimulatedBadge />}
                      {relative(read.occurred_at)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
