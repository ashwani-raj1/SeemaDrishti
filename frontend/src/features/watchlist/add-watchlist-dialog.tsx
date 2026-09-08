import { useState, useEffect } from "react";
import { toast } from "sonner";
import { PlusIcon, SaveIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ibvap/spinner";
import { api } from "@/lib/api";
import { formatPlate } from "@/lib/format";
import type { Severity, WatchlistEntry } from "@/lib/types";

interface AddWatchlistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry?: WatchlistEntry | null;
  onSuccess: () => void;
}

export function AddWatchlistDialog({
  open,
  onOpenChange,
  entry,
  onSuccess,
}: AddWatchlistDialogProps) {
  const [plateNumber, setPlateNumber] = useState("");
  const [vehicleType, setVehicleType] = useState("car");
  const [makeModel, setMakeModel] = useState("");
  const [color, setColor] = useState("");
  const [severity, setSeverity] = useState<Severity>("WARNING");
  const [flagReason, setFlagReason] = useState("");
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  const [changeReason, setChangeReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (entry) {
      setPlateNumber(entry.plate_number);
      setVehicleType(entry.vehicle_type);
      setMakeModel(entry.make_model ?? "");
      setColor(entry.color ?? "");
      setSeverity(entry.severity);
      setFlagReason(entry.flag_reason);
      setNotes(entry.notes ?? "");
      setActive(entry.active);
      setChangeReason("");
    } else {
      setPlateNumber("");
      setVehicleType("car");
      setMakeModel("");
      setColor("");
      setSeverity("WARNING");
      setFlagReason("");
      setNotes("");
      setActive(true);
      setChangeReason("");
    }
  }, [entry, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plateNumber.trim()) {
      toast.error("License plate number is required");
      return;
    }
    if (!flagReason.trim()) {
      toast.error("Flag reason is required");
      return;
    }

    setSaving(true);
    try {
      if (entry) {
        await api.updateWatchlistEntry(entry.id, {
          plateNumber: plateNumber.trim(),
          vehicleType,
          makeModel: makeModel.trim() || null,
          color: color.trim() || null,
          severity,
          flagReason: flagReason.trim(),
          notes: notes.trim() || null,
          active,
          reason: changeReason.trim() || "Watchlist entry updated",
        });
        toast.success(`Updated watchlist entry for ${formatPlate(plateNumber)}`);
      } else {
        await api.createWatchlistEntry({
          plateNumber: plateNumber.trim(),
          vehicleType,
          makeModel: makeModel.trim() || null,
          color: color.trim() || null,
          severity,
          flagReason: flagReason.trim(),
          notes: notes.trim() || null,
          active,
        });
        toast.success(`Added ${formatPlate(plateNumber)} to watchlist`);
      }

      onOpenChange(false);
      onSuccess();
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{entry ? "Edit Watchlist Entry" : "Add Vehicle to Watchlist"}</DialogTitle>
            <DialogDescription className="text-xs">
              {entry
                ? "Update vehicle details or alert severity. Changes are permanently recorded in the audit trail."
                : "Flag a vehicle registration number to trigger automated alerts when spotted by perimeter cameras."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">License Plate *</Label>
                <Input
                  placeholder="e.g. PB 02 AK 4821"
                  value={plateNumber}
                  onChange={(e) => setPlateNumber(e.target.value.toUpperCase())}
                  className="font-mono text-sm uppercase font-bold"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Vehicle Type</Label>
                <Select value={vehicleType} onValueChange={setVehicleType}>
                  <SelectTrigger className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="car">Car / Sedan</SelectItem>
                    <SelectItem value="suv">SUV / Bolero</SelectItem>
                    <SelectItem value="truck">Commercial Truck</SelectItem>
                    <SelectItem value="tractor">Tractor</SelectItem>
                    <SelectItem value="motorcycle">Motorcycle</SelectItem>
                    <SelectItem value="bus">Bus</SelectItem>
                    <SelectItem value="van">Van</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Make / Model</Label>
                <Input
                  placeholder="e.g. Scorpio-N"
                  value={makeModel}
                  onChange={(e) => setMakeModel(e.target.value)}
                  className="text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Color</Label>
                <Input
                  placeholder="e.g. Black"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Severity</Label>
                <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
                  <SelectTrigger className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CRITICAL">CRITICAL</SelectItem>
                    <SelectItem value="WARNING">WARNING</SelectItem>
                    <SelectItem value="INFO">INFO</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Flag Reason *</Label>
              <Input
                placeholder="e.g. Suspected contraband transport / BOLO alert"
                value={flagReason}
                onChange={(e) => setFlagReason(e.target.value)}
                className="text-xs"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Tactical Notes & Instructions</Label>
              <Textarea
                placeholder="e.g. Occupants armed. Alert QRT immediately."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="text-xs"
              />
            </div>

            {entry && (
              <div className="space-y-1.5 pt-2 border-t">
                <Label className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                  Reason for Change (Audit Requirement)
                </Label>
                <Input
                  placeholder="e.g. Intelligence update from district HQ"
                  value={changeReason}
                  onChange={(e) => setChangeReason(e.target.value)}
                  className="text-xs"
                />
              </div>
            )}

            <div className="flex items-center justify-between rounded-md border p-2.5 bg-muted/30">
              <div className="space-y-0.5">
                <Label className="text-xs font-semibold">Watchlist Status</Label>
                <p className="text-[11px] text-muted-foreground">
                  Active entries trigger alarms upon optical plate match.
                </p>
              </div>
              <Switch checked={active} onCheckedChange={setActive} />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Spinner /> : entry ? <SaveIcon className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
              {entry ? "Save Changes" : "Add to Watchlist"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
