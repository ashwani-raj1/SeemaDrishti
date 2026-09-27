import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CameraIcon, ClockIcon, DownloadIcon, XIcon } from "lucide-react";
import { formatPlate } from "@/lib/format";

interface SnapshotModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: string | null;
  label?: string;
  metadata?: {
    plateNumber?: string;
    cameraName?: string;
    occurredAt?: string;
    confidence?: number;
    matchStatus?: string;
  };
}

export function SnapshotModal({
  open,
  onOpenChange,
  snapshot,
  label = "Detection Snapshot",
  metadata,
}: SnapshotModalProps) {
  if (!snapshot) return null;

  const isBase64OrUrl =
    snapshot.startsWith("data:image/") ||
    snapshot.startsWith("blob:") ||
    snapshot.startsWith("http://") ||
    snapshot.startsWith("https://") ||
    snapshot.startsWith("/");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden bg-stone-950 border-stone-800 text-stone-100 shadow-2xl">
        <DialogHeader className="p-4 border-b border-stone-800 flex flex-row items-center justify-between">
          <div>
            <DialogTitle className="text-base font-semibold flex items-center gap-2">
              <CameraIcon className="w-4 h-4 text-emerald-400" />
              {label}
            </DialogTitle>
            {metadata?.occurredAt && (
              <p className="text-xs text-stone-400 mt-1 flex items-center gap-1.5">
                <ClockIcon className="w-3.5 h-3.5" />
                {metadata.occurredAt}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {metadata?.plateNumber && (
              <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30">
                {formatPlate(metadata.plateNumber)}
              </span>
            )}
            {metadata?.matchStatus === "MATCHED" && (
              <Badge variant="destructive" className="text-xs">
                WATCHLIST MATCH
              </Badge>
            )}
          </div>
        </DialogHeader>

        <div className="relative min-h-[300px] max-h-[70vh] flex items-center justify-center bg-stone-900/60 p-4">
          {isBase64OrUrl ? (
            <img
              src={snapshot}
              alt={label}
              className="max-h-[60vh] max-w-full rounded object-contain border border-stone-800 shadow"
            />
          ) : (
            <div className="flex flex-col items-center justify-center p-12 text-center text-stone-400 border border-dashed border-stone-700 rounded-lg">
              <CameraIcon className="w-12 h-12 text-stone-600 mb-3" />
              <div className="text-sm font-medium text-stone-300">Preset Snapshot Record</div>
              <div className="font-mono text-xs text-stone-500 mt-1">Identifier: {snapshot}</div>
              <p className="text-xs text-stone-400 max-w-md mt-2">
                Simulated sensor reference logged in edge database. Real field camera feeds populate direct H.264
                frame crops.
              </p>
            </div>
          )}
        </div>

        {metadata && (
          <div className="p-3 bg-stone-900 border-t border-stone-800 text-xs flex flex-wrap items-center justify-between gap-3 text-stone-300">
            <div className="flex items-center gap-4">
              {metadata.cameraName && (
                <div>
                  <span className="text-stone-500">Camera:</span>{" "}
                  <span className="font-medium text-stone-200">{metadata.cameraName}</span>
                </div>
              )}
              {metadata.confidence !== undefined && (
                <div>
                  <span className="text-stone-500">Confidence:</span>{" "}
                  <span className="font-medium text-emerald-400">
                    {(metadata.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              )}
            </div>
            {isBase64OrUrl && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs border-stone-700 bg-stone-800 hover:bg-stone-700 text-stone-200"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = snapshot;
                  a.download = `snapshot_${metadata.plateNumber || "detection"}.jpg`;
                  a.click();
                }}
              >
                <DownloadIcon className="w-3.5 h-3.5 mr-1" />
                Download Crop
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
