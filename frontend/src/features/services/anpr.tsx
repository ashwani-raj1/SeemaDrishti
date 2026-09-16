import { useCallback, useState } from "react";
import { PageShell } from "@/components/ibvap/page-shell";
import { api } from "@/lib/api";
import type { PlateDetection } from "@/lib/types";
import { PlateScannerCanvas } from "../watchlist/plate-scanner-canvas";

/**
 * Focused ANPR workbench. Watchlist management deliberately remains on its
 * own page; this screen is only for detecting and counting vehicles and
 * reading plates from an uploaded video or a live camera.
 */
export function AnprScreen() {
  const [detection, setDetection] = useState<PlateDetection | null>(null);
  const [scanning, setScanning] = useState(false);

  const runPreset = useCallback(async (preset: string) => {
    setScanning(true);
    try {
      setDetection(await api.simulatePlateDetection(preset));
    } finally {
      setScanning(false);
    }
  }, []);

  const scanPlate = useCallback(async (plate: string, vehicleType: string, cameraId: string) => {
    setScanning(true);
    try {
      setDetection(await api.detectVehicleAndPlate({
        plateNumber: plate,
        vehicleType,
        cameraId,
        simulated: false,
      }));
    } finally {
      setScanning(false);
    }
  }, []);

  return (
    <PageShell
      title="Vehicle & number plate detection"
      description="Upload a video or use a live camera to detect vehicles, count them once, and read visible registration plates."
    >
      <PlateScannerCanvas
        detection={detection}
        scanning={scanning}
        onRunScan={runPreset}
        onManualScan={scanPlate}
        autoStartUpload
        countOnFirstDetection
      />
    </PageShell>
  );
}
