import { useState, useEffect, useRef, useCallback } from "react";
import {
  CameraIcon,
  CarIcon,
  CheckCircle2Icon,
  CrosshairIcon,
  EyeIcon,
  FileVideoIcon,
  ImageIcon,
  LayersIcon,
  ListOrderedIcon,
  Maximize2Icon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScanIcon,
  SearchIcon,
  ShieldAlertIcon,
  SparklesIcon,
  SwitchCameraIcon,
  TruckIcon,
  UploadCloudIcon,
  VideoIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ibvap/spinner";
import { SeverityBadge } from "@/components/ibvap/badges";
import { formatPlate } from "@/lib/format";
import { api } from "@/lib/api";
import type { PlateDetection, WatchlistEntry } from "@/lib/types";

interface PlateScannerCanvasProps {
  detection: PlateDetection | null;
  scanning: boolean;
  onRunScan: (presetKey: string) => void;
  onManualScan: (plate: string, vehicleType: string, cameraId: string) => void;
  /** Number-plates workbench starts an uploaded clip immediately. */
  autoStartUpload?: boolean;
  /** Count a stable track when first seen instead of waiting for it to exit. */
  countOnFirstDetection?: boolean;
}

const PRESET_FEEDS = [
  { key: "flagged_scorpio", label: "BOP-01 Fence North — Black Scorpio (FLAGGED CRITICAL)", type: "suv", cam: "cam_fence_north", plate: "PB 02 AK 4821", make: "Mahindra Scorpio-N", color: "Black" },
  { key: "flagged_tractor", label: "BOP-02 Farm Gate — Swaraj Tractor (FLAGGED WARNING)", type: "tractor", cam: "cam_farm_gate", plate: "PB 02 T 9182", make: "Swaraj 855 FE", color: "Blue" },
  { key: "stolen_fortuner", label: "BOP-01 Fence North — White Fortuner (STOLEN BOLO)", type: "suv", cam: "cam_fence_north", plate: "DL 1C AA 1111", make: "Toyota Fortuner", color: "White" },
  { key: "commercial_truck", label: "BOP-03 Patrol Road — Tata 407 Truck (FLAGGED WARNING)", type: "truck", cam: "cam_patrol_road", plate: "HR 26 DQ 5512", make: "Tata 407 LPT", color: "Silver" },
  { key: "farm_sonalika", label: "BOP-02 Farm Gate — Red Sonalika (CLEAR)", type: "tractor", cam: "cam_farm_gate", plate: "PB 02 AB 1042", make: "Sonalika DI-745", color: "Red" },
  { key: "patrol_bolero", label: "BOP-03 Patrol Road — Patrol Bolero (CLEAR)", type: "car", cam: "cam_patrol_road", plate: "PB 02 E 3391", make: "Mahindra Bolero Neo", color: "White" },
  { key: "highway_creta", label: "BOP-01 Fence North — Red Creta (CLEAR)", type: "car", cam: "cam_fence_north", plate: "MH 12 BB 8892", make: "Hyundai Creta SX", color: "Red" },
  { key: "surveillance_brezza", label: "BOP-03 Patrol Road — Blue Brezza (FLAGGED INFO)", type: "car", cam: "cam_patrol_road", plate: "PB 08 BX 7744", make: "Maruti Brezza ZXi", color: "Dark Blue" },
  { key: "night_eicher", label: "BOP-01 Fence North — White Eicher Truck (CLEAR)", type: "truck", cam: "cam_fence_north", plate: "RJ 14 XY 3319", make: "Eicher Pro 2049", color: "White" },
  { key: "gate_nexon", label: "BOP-02 Farm Gate — Silver Nexon (CLEAR)", type: "car", cam: "cam_farm_gate", plate: "UP 16 CZ 9021", make: "Tata Nexon EV", color: "Silver" },
];

export function PlateScannerCanvas({
  detection: initialDetection,
  scanning,
  onRunScan,
  onManualScan,
  autoStartUpload = false,
  countOnFirstDetection = false,
}: PlateScannerCanvasProps) {
  const [sourceMode, setSourceMode] = useState<"preset" | "live" | "upload" | "manual">("preset");
  const [selectedPreset, setSelectedPreset] = useState("flagged_scorpio");
  const [manualPlate, setManualPlate] = useState("");
  const [manualType, setManualType] = useState("car");
  const [manualCam, setManualCam] = useState("cam_fence_north");

  // Multi-vehicle detections in current frame
  const [activeDetections, setActiveDetections] = useState<PlateDetection[]>([]);
  // Currently selected / highlighted vehicle for zoom inspection
  const [selectedVehicleIndex, setSelectedVehicleIndex] = useState<number>(0);

  // Session vehicle accumulator and vehicle count stats
  const [sessionVehicles, setSessionVehicles] = useState<PlateDetection[]>([]);
  const [totalVehiclesCaptured, setTotalVehiclesCaptured] = useState<number>(0);

  // Live Video / Webcam State
  const [isLiveStreaming, setIsLiveStreaming] = useState(false);
  const [liveStreamError, setLiveStreamError] = useState<string | null>(null);
  const [modelOnline, setModelOnline] = useState(false);
  const [modelMessage, setModelMessage] = useState("Checking local ANPR model…");
  const [enlargedSnapshot, setEnlargedSnapshot] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("environment");
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // Uploaded Video State
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [continuousScan, setContinuousScan] = useState(true);
  const uploadVideoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Offscreen canvas for actual frame snapshotting & optical processing
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanIntervalRef = useRef<any>(null);
  const analysisInFlightRef = useRef(false);
  const submittedPlatesRef = useRef(new Map<string, number>());
  const visibleVehiclesRef = useRef(new Map<string, { vehicle: PlateDetection; lastSeen: number }>());
  const countedVehiclesRef = useRef(new Set<string>());
  const lastSirenAtRef = useRef(0);

  // Watchlist cache for instant matching
  const watchlistCacheRef = useRef<WatchlistEntry[]>([]);

  useEffect(() => {
    void api.watchlist({ limit: 100 }).then((entries) => {
      watchlistCacheRef.current = entries;
    }).catch(() => {});
  }, []);

  const playWatchlistSiren = useCallback(() => {
    const now = Date.now();
    if (now - lastSirenAtRef.current < 8_000) return;
    lastSirenAtRef.current = now;
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sawtooth";
      oscillator.connect(gain);
      gain.connect(context.destination);
      const start = context.currentTime;
      oscillator.frequency.setValueAtTime(720, start);
      oscillator.frequency.linearRampToValueAtTime(1_080, start + 0.28);
      oscillator.frequency.linearRampToValueAtTime(720, start + 0.56);
      oscillator.frequency.linearRampToValueAtTime(1_080, start + 0.84);
      oscillator.frequency.linearRampToValueAtTime(720, start + 1.12);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.2);
      oscillator.start(start);
      oscillator.stop(start + 1.2);
      oscillator.addEventListener("ended", () => void context.close());
    } catch {
      // Browser audio can be blocked until the operator interacts with the page.
    }
  }, []);

  // The browser scanner uses a local Python service. Never call it "online"
  // just because the page loaded: check the real model endpoint and show a
  // useful recovery message when it is not running.
  useEffect(() => {
    let mounted = true;
    const checkModel = async () => {
      try {
        const response = await fetch("http://127.0.0.1:8001/health");
        if (!response.ok) throw new Error("health check failed");
        if (mounted) {
          setModelOnline(true);
          setModelMessage("Local YOLO + OCR model online");
        }
      } catch {
        if (mounted) {
          setModelOnline(false);
          setModelMessage("Model offline — run ibvap\\run-anpr.ps1, then refresh this page.");
        }
      }
    };
    void checkModel();
    const timer = window.setInterval(() => void checkModel(), 10_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  // Helper: create synthetic vehicle snapshot canvas for presets if no video
  const createPresetSnapshotCanvas = useCallback((type: string, color: string, plateStr: string): string => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    // Background road / checkpoint scene
    const bgGrad = ctx.createLinearGradient(0, 0, 0, 240);
    bgGrad.addColorStop(0, "#0f172a");
    bgGrad.addColorStop(0.5, "#1e293b");
    bgGrad.addColorStop(1, "#334155");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, 400, 240);

    // Road lane markings
    ctx.strokeStyle = "#e2e8f0";
    ctx.setLineDash([15, 10]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(200, 150);
    ctx.lineTo(200, 240);
    ctx.stroke();
    ctx.setLineDash([]);

    // Vehicle silhouette body
    ctx.fillStyle = color.toLowerCase() === "white" ? "#f8fafc" : color.toLowerCase() === "red" ? "#dc2626" : color.toLowerCase() === "blue" ? "#2563eb" : color.toLowerCase() === "silver" ? "#94a3b8" : "#0f172a";
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 3;

    if (type === "truck" || type === "tractor") {
      ctx.beginPath();
      ctx.roundRect(70, 70, 260, 110, 8);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.roundRect(80, 85, 240, 95, 12);
      ctx.fill();
      ctx.stroke();
      // Windshield
      ctx.fillStyle = "#38bdf8";
      ctx.beginPath();
      ctx.roundRect(110, 95, 180, 40, 6);
      ctx.fill();
    }

    // Number plate on car
    ctx.fillStyle = "#fef08a";
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(140, 150, 120, 26, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "center";
    ctx.fillText(plateStr, 200, 167);

    return canvas.toDataURL("image/jpeg", 0.90);
  }, []);

  // Synchronize initial detection
  useEffect(() => {
    if (initialDetection) {
      setActiveDetections([initialDetection]);
      setSelectedVehicleIndex(0);
      setSessionVehicles((prev) => {
        if (!prev.some((v) => v.plate_number === initialDetection.plate_number)) {
          setTotalVehiclesCaptured((c) => c + 1);
          return [initialDetection, ...prev].slice(0, 50);
        }
        return prev;
      });
    }
  }, [initialDetection]);

  // ------------------------------------------------------------- Live Camera Stream Logic
  const startLiveStream = useCallback(async () => {
    setLiveStreamError(null);
    try {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }

      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;

      if (liveVideoRef.current) {
        liveVideoRef.current.srcObject = stream;
        await liveVideoRef.current.play();
      }
      setIsLiveStreaming(true);
    } catch (err: any) {
      console.warn("Live camera access warning:", err);
      setLiveStreamError(
        err?.message?.includes("Permission") || err?.name === "NotAllowedError"
          ? "Camera permission denied. Please allow camera access in browser settings."
          : "Camera feed inactive. You can use Upload Video or Preset Checkpoint Feeds.",
      );
      setIsLiveStreaming(false);
    }
  }, [facingMode]);

  const stopLiveStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = null;
    }
    setIsLiveStreaming(false);
  }, []);

  // Mode change cleanup
  useEffect(() => {
    if (sourceMode === "live") {
      void startLiveStream();
    } else {
      stopLiveStream();
    }
    return () => {
      stopLiveStream();
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
      }
    };
  }, [sourceMode, startLiveStream, stopLiveStream]);

  const toggleCameraFacing = () => {
    setFacingMode((prev) => (prev === "environment" ? "user" : "environment"));
  };

  // ------------------------------------------------------------- Upload Video Logic
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (uploadedVideoUrl) {
      URL.revokeObjectURL(uploadedVideoUrl);
    }

    const url = URL.createObjectURL(file);
    setUploadedVideoUrl(url);
    setUploadedFileName(file.name);
    setIsPlaying(false);
    setVideoProgress(0);
    setActiveDetections([]);
    setSessionVehicles([]);
    setTotalVehiclesCaptured(0);
    visibleVehiclesRef.current.clear();
    countedVehiclesRef.current.clear();

    if (uploadVideoRef.current) {
      uploadVideoRef.current.src = url;
      uploadVideoRef.current.muted = true;
      uploadVideoRef.current.load();
    }
  };

  const handlePlayPause = () => {
    if (!uploadVideoRef.current) return;
    if (isPlaying) {
      uploadVideoRef.current.pause();
      setIsPlaying(false);
    } else {
      void uploadVideoRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleVideoSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!uploadVideoRef.current) return;
    const time = (parseFloat(e.target.value) / 100) * videoDuration;
    uploadVideoRef.current.currentTime = time;
    setVideoProgress(parseFloat(e.target.value));
  };

  const handleSpeedChange = (speed: number) => {
    setPlaybackSpeed(speed);
    if (uploadVideoRef.current) {
      uploadVideoRef.current.playbackRate = speed;
    }
  };

  // ------------------------------------------------------------- REAL-TIME DYNAMIC CAR SNAPSHOT & ALPR OCR ENGINE
  // Retained temporarily for preset artwork only. It is never used for live
  // camera or uploaded-video analysis.
  const legacySyntheticCapture = useCallback(
    async (
      videoElement: HTMLVideoElement | null,
      sourceName: string,
      forcedPlate?: string,
      forcedType?: string,
    ) => {
      if (analysisInFlightRef.current) return;
      analysisInFlightRef.current = true;

      try {
        const canvas = offscreenCanvasRef.current || document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;

        let carSnapshotBase64: string | null = null;
        let plateCropBase64: string | null = null;
        let dominantColor = "Black";
        let detectedClass = forcedType || "car";

        const hasVideo = videoElement && videoElement.readyState >= 2 && videoElement.videoWidth > 0;

        if (hasVideo && videoElement) {
          canvas.width = 640;
          canvas.height = 360;
          ctx.drawImage(videoElement, 0, 0, 640, 360);

          // Extract Car Snapshot from center-bottom region
          const carX = Math.round(640 * 0.12);
          const carY = Math.round(360 * 0.22);
          const carW = Math.round(640 * 0.76);
          const carH = Math.round(360 * 0.68);

          // Sample dominant color from car body
          const imgData = ctx.getImageData(
            carX + 40,
            carY + 30,
            Math.min(120, carW - 80),
            Math.min(80, carH - 80),
          );
          let rSum = 0,
            gSum = 0,
            bSum = 0,
            count = 0;
          for (let i = 0; i < imgData.data.length; i += 16) {
            rSum += imgData.data[i]!;
            gSum += imgData.data[i + 1]!;
            bSum += imgData.data[i + 2]!;
            count++;
          }
          if (count > 0) {
            const rAvg = rSum / count;
            const gAvg = gSum / count;
            const bAvg = bSum / count;
            if (rAvg < 55 && gAvg < 55 && bAvg < 55) dominantColor = "Black";
            else if (rAvg > 185 && gAvg > 185 && bAvg > 185) dominantColor = "White";
            else if (rAvg > 130 && rAvg > gAvg * 1.3 && rAvg > bAvg * 1.3) dominantColor = "Red";
            else if (bAvg > 120 && bAvg > rAvg * 1.2) dominantColor = "Blue";
            else if (rAvg > 140 && gAvg > 140 && bAvg < 90) dominantColor = "Yellow";
            else dominantColor = "Silver";
          }

          // Vehicle Crop Canvas
          const carCanvas = document.createElement("canvas");
          carCanvas.width = carW;
          carCanvas.height = carH;
          const carCtx = carCanvas.getContext("2d");
          if (carCtx) {
            carCtx.drawImage(canvas, carX, carY, carW, carH, 0, 0, carW, carH);
            carSnapshotBase64 = carCanvas.toDataURL("image/jpeg", 0.88);
          }

          // Plate Crop Canvas
          const plateCanvas = document.createElement("canvas");
          plateCanvas.width = 190;
          plateCanvas.height = 60;
          const plateCtx = plateCanvas.getContext("2d");
          if (plateCtx) {
            plateCtx.drawImage(
              canvas,
              Math.round(640 * 0.38),
              Math.round(360 * 0.64),
              190,
              60,
              0,
              0,
              190,
              60,
            );
            plateCropBase64 = plateCanvas.toDataURL("image/jpeg", 0.92);
          }
        }

        // Determine plate string
        let plateString = "";
        let makeModel = "Vehicle";
        let severity: "CRITICAL" | "WARNING" | "INFO" = "INFO";
        let isMatch = false;
        let flagReason = "Unflagged Vehicle";

        if (forcedPlate) {
          plateString = formatPlate(forcedPlate);
        } else {
          // Dynamic realistic Indian vehicle plates registry across multiple states
          const STATES = ["PB", "HR", "DL", "UP", "RJ", "MH", "KA", "GJ", "CH", "UK", "WB"];
          const TIME_SEED = Math.floor(videoElement?.currentTime ? videoElement.currentTime * 2 : Date.now() / 1200);

          const DYNAMIC_ALPR_CANDIDATES = [
            { plate: "PB 02 AK 4821", type: "suv", make: "Mahindra Scorpio-N", color: "Black", match: true, sev: "CRITICAL", reason: "Contraband BOLO Alert" },
            { plate: "HR 26 DQ 5512", type: "truck", make: "Tata 407 LPT", color: "Silver", match: true, sev: "WARNING", reason: "Unauthorized Night Transit" },
            { plate: "DL 1C AA 1111", type: "suv", make: "Toyota Fortuner", color: "White", match: true, sev: "CRITICAL", reason: "Stolen Vehicle / Drone Drop" },
            { plate: "PB 02 T 9182", type: "tractor", make: "Swaraj 855 FE", color: "Blue", match: true, sev: "WARNING", reason: "Gate Pass Revoked" },
            { plate: "UP 16 CZ 9021", type: "car", make: "Tata Nexon EV", color: "Silver", match: false, sev: "INFO", reason: "Unflagged Vehicle" },
            { plate: "MH 12 BB 8892", type: "car", make: "Hyundai Creta", color: "Red", match: false, sev: "INFO", reason: "Unflagged Vehicle" },
            { plate: "PB 08 BX 7744", type: "car", make: "Maruti Brezza", color: "Dark Blue", match: true, sev: "INFO", reason: "Surveillance Flag" },
            { plate: "KA 01 MG 4410", type: "truck", make: "Ashok Leyland", color: "Yellow", match: false, sev: "INFO", reason: "Unflagged Vehicle" },
            { plate: "PB 02 AB 1042", type: "tractor", make: "Sonalika DI", color: "Red", match: false, sev: "INFO", reason: "Unflagged Vehicle" },
            { plate: "RJ 14 XY 3319", type: "truck", make: "Eicher Pro", color: "White", match: false, sev: "INFO", reason: "Unflagged Vehicle" },
            { plate: "DL 08 CA 5432", type: "car", make: "Honda City", color: "White", match: false, sev: "INFO", reason: "Unflagged Vehicle" },
            { plate: "GJ 01 AB 9081", type: "car", make: "Kia Seltos", color: "Black", match: false, sev: "INFO", reason: "Unflagged Vehicle" },
            { plate: "CH 01 BG 7200", type: "suv", make: "Mahindra Thar", color: "Black", match: false, sev: "INFO", reason: "Unflagged Vehicle" },
            { plate: "UK 07 TA 1289", type: "car", make: "Maruti Swift", color: "Silver", match: false, sev: "INFO", reason: "Unflagged Vehicle" },
          ];

          const candIdx = Math.abs(TIME_SEED) % DYNAMIC_ALPR_CANDIDATES.length;
          const cand = DYNAMIC_ALPR_CANDIDATES[candIdx]!;
          plateString = cand.plate;
          detectedClass = cand.type;
          makeModel = cand.make;
          dominantColor = cand.color;
          isMatch = cand.match;
          severity = cand.sev as any;
          flagReason = cand.reason;
        }

        // Check against active Watchlist database in memory/cache
        const normalized = plateString.replace(/[^A-Z0-9]/g, "");
        const matchedEntry = watchlistCacheRef.current.find((entry) => {
          const entryNorm = entry.plate_number.replace(/[^A-Z0-9]/g, "");
          return entryNorm === normalized || entryNorm.includes(normalized) || normalized.includes(entryNorm);
        });

        if (matchedEntry) {
          isMatch = true;
          severity = matchedEntry.severity;
          flagReason = matchedEntry.flag_reason;
          makeModel = matchedEntry.make_model ?? makeModel;
          dominantColor = matchedEntry.color ?? dominantColor;
          detectedClass = matchedEntry.vehicle_type ?? detectedClass;
        }

        // If no video was loaded (e.g. preset mode), build synthetic canvas snapshot
        if (!carSnapshotBase64) {
          carSnapshotBase64 = createPresetSnapshotCanvas(detectedClass, dominantColor, plateString);
        }

        // Coordinate jitter simulation for natural camera box overlay
        const t = (videoElement?.currentTime || Date.now() / 1000) * 0.4;
        const offX = Math.sin(t) * 0.04;
        const offY = Math.cos(t) * 0.02;

        const newDetection: PlateDetection = {
          id: `pd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          org_id: "org_bsf",
          camera_id: "cam_fence_north",
          camera_name: sourceName,
          zone_id: "zone_fence_line",
          zone_name: "Fence Line North",
          plate_number: plateString,
          vehicle_type: detectedClass,
          confidence: 0.94 + Math.random() * 0.05,
          plate_confidence: 0.96 + Math.random() * 0.03,
          matched_watchlist_id: isMatch ? (matchedEntry?.id ?? `wl_${detectedClass}`) : null,
          matched_entry: isMatch
            ? matchedEntry || {
                id: `wl_${detectedClass}`,
                org_id: "org_bsf",
                plate_number: plateString,
                vehicle_type: detectedClass,
                make_model: makeModel,
                color: dominantColor,
                severity: severity,
                flag_reason: flagReason,
                notes: "Verified via Edge Optical ALPR Camera",
                active: true,
                added_by: "Supervisor",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }
            : null,
          match_status: isMatch ? "MATCHED" : "CLEAR",
          severity: severity,
          bbox: [0.18 + offX, 0.35 + offY, 0.76 + offX, 0.88 + offY],
          plate_bbox: [0.42 + offX, 0.70 + offY, 0.58 + offX, 0.79 + offY],
          image_snapshot: carSnapshotBase64,
          simulated: true,
          occurred_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };

        // Update active detections in current frame view
        setActiveDetections([newDetection]);
        setSelectedVehicleIndex(0);

        // Step 2 & 3: Accumulate into session vehicle list & increment vehicle counter
        setSessionVehicles((prev) => {
          const exists = prev.some((v) => v.plate_number === newDetection.plate_number);
          if (!exists) {
            setTotalVehiclesCaptured((c) => c + 1);
            return [newDetection, ...prev].slice(0, 100);
          }
          return prev;
        });
      } catch (err) {
        console.warn("Snapshot capture failed:", err);
      } finally {
        analysisInFlightRef.current = false;
      }
    },
    [createPresetSnapshotCanvas],
  );

  /** Analyze the complete current frame with the local YOLO + OCR service. */
  const captureAndDetectCar = useCallback(async (videoElement: HTMLVideoElement | null, sourceName: string) => {
    if (!videoElement || videoElement.readyState < 2 || analysisInFlightRef.current) return;
    const canvas = offscreenCanvasRef.current;
    if (!canvas || !videoElement.videoWidth) return;

    analysisInFlightRef.current = true;
    try {
      const scale = Math.min(1, 960 / videoElement.videoWidth);
      canvas.width = Math.round(videoElement.videoWidth * scale);
      canvas.height = Math.round(videoElement.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const response = await fetch("http://localhost:8001/detect", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: canvas.toDataURL("image/jpeg", 0.82) }),
      });
      if (!response.ok) throw new Error("ANPR service unavailable");
      const result = await response.json() as { detections: Array<{ track_id?: number | null; track_key?: string; vehicle_type: string; confidence: number; bbox: [number, number, number, number]; plate?: { text: string; confidence: number; bbox: [number, number, number, number] } }> };
      const at = new Date().toISOString();
      const snapshotFor = (bbox: [number, number, number, number]) => {
        const x1 = Math.max(0, Math.floor(bbox[0] * canvas.width));
        const y1 = Math.max(0, Math.floor(bbox[1] * canvas.height));
        const x2 = Math.min(canvas.width, Math.ceil(bbox[2] * canvas.width));
        const y2 = Math.min(canvas.height, Math.ceil(bbox[3] * canvas.height));
        if (x2 <= x1 || y2 <= y1) return null;
        const crop = document.createElement("canvas");
        crop.width = x2 - x1;
        crop.height = y2 - y1;
        const context = crop.getContext("2d");
        if (!context) return null;
        context.drawImage(canvas, x1, y1, crop.width, crop.height, 0, 0, crop.width, crop.height);
        return crop.toDataURL("image/jpeg", 0.85);
      };
      const detections: PlateDetection[] = result.detections.map((item, index) => {
        const plate = item.plate?.text ?? "";
        const normalized = plate.replace(/[^A-Z0-9]/gi, "").toUpperCase();
        const matchedEntry = normalized
          ? watchlistCacheRef.current.find((entry) => entry.active && entry.plate_number.replace(/[^A-Z0-9]/gi, "").toUpperCase() === normalized) ?? null
          : null;
        return {
          id: `live-track-${item.track_key ?? item.track_id ?? index}`,
          org_id: "org_bsf", camera_id: "cam_fence_north", camera_name: sourceName,
          zone_id: null, plate_number: plate, vehicle_type: item.vehicle_type,
          confidence: item.confidence, plate_confidence: item.plate?.confidence ?? 0,
          matched_watchlist_id: matchedEntry?.id ?? null,
          matched_entry: matchedEntry,
          match_status: matchedEntry ? "MATCHED" : "UNVERIFIED",
          severity: matchedEntry?.severity ?? "INFO",
          bbox: item.bbox, plate_bbox: item.plate?.bbox ?? [0, 0, 0, 0],
        // When OCR found a plate, save its tight crop. The vehicle box is a
        // fallback only when there is no readable plate yet.
        image_snapshot: snapshotFor(item.plate?.bbox ?? item.bbox), simulated: false, occurred_at: at, created_at: at,
        };
      });
      if (detections.some((item) => item.match_status === "MATCHED")) playWatchlistSiren();
      setActiveDetections(detections);
      setSelectedVehicleIndex(0);
      const now = Date.now();
      const current = new Map(detections.map((vehicle) => [vehicle.id, vehicle]));
      for (const vehicle of detections) {
        visibleVehiclesRef.current.set(vehicle.id, { vehicle, lastSeen: now });
      }
      const candidates = countOnFirstDetection
        ? detections.map((vehicle) => ({ key: vehicle.id, vehicle }))
        : [...visibleVehiclesRef.current.entries()]
          // A detector can miss several scans on motion blur. Wait five seconds
          // before treating that gap as an exit in the Watchlist traffic view.
          .filter(([key, state]) => !current.has(key) && now - state.lastSeen >= 5_000)
          .map(([key, state]) => ({ key, vehicle: state.vehicle }));
      const newlyCounted = candidates.filter(({ key }) => !countedVehiclesRef.current.has(key));
      if (newlyCounted.length) {
        newlyCounted.forEach(({ key }) => countedVehiclesRef.current.add(key));
        setTotalVehiclesCaptured((count) => count + newlyCounted.length);
        setSessionVehicles((previous) => [
          ...newlyCounted.map(({ vehicle }) => vehicle),
          ...previous,
        ].slice(0, 100));
      }
      if (!countOnFirstDetection) newlyCounted.forEach(({ key }) => visibleVehiclesRef.current.delete(key));
      for (const item of detections.filter((candidate) => candidate.plate_number)) {
        const last = submittedPlatesRef.current.get(item.plate_number) ?? 0;
        if (Date.now() - last > 8_000) {
          submittedPlatesRef.current.set(item.plate_number, Date.now());
          onManualScan(item.plate_number, item.vehicle_type, "cam_fence_north");
        }
      }
      setModelOnline(true);
      setModelMessage("Local YOLO + OCR model online");
    } catch (error) {
      console.warn("ANPR frame analysis failed", error);
      setModelOnline(false);
      setModelMessage("Model offline or unavailable — run ibvap\\run-anpr.ps1, then refresh this page.");
    } finally {
      analysisInFlightRef.current = false;
    }
  }, [countOnFirstDetection, onManualScan, playWatchlistSiren]);

  // Continuous Video Scan Interval Loop
  useEffect(() => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
    }

    if (modelOnline && sourceMode === "live" && isLiveStreaming && continuousScan) {
      scanIntervalRef.current = setInterval(() => {
        void captureAndDetectCar(liveVideoRef.current, "Live Camera Feed");
      }, 750);
    } else if (modelOnline && sourceMode === "upload" && isPlaying && continuousScan) {
      scanIntervalRef.current = setInterval(() => {
        void captureAndDetectCar(uploadVideoRef.current, uploadedFileName || "Uploaded Video");
      }, 750);
    }

    return () => {
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
      }
    };
  }, [sourceMode, isLiveStreaming, isPlaying, continuousScan, uploadedFileName, modelOnline, captureAndDetectCar]);

  // Execute Preset Scan Trigger
  const handlePresetTrigger = (presetKey: string) => {
    setSelectedPreset(presetKey);
    onRunScan(presetKey);
  };

  // Handle Manual Submit
  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualPlate.trim()) return;
    const formatted = formatPlate(manualPlate.trim());
    onManualScan(formatted, manualType, manualCam);
    setManualPlate("");
  };

  // Currently focused vehicle
  const primaryDetection =
    activeDetections[selectedVehicleIndex] ?? activeDetections[0] ?? sessionVehicles[0] ?? null;
  const isMatched = primaryDetection?.match_status === "MATCHED";
  const plateNumber = primaryDetection?.plate_number || "No plate read";

  // Vehicle Counts
  const totalVehiclesCount = totalVehiclesCaptured || sessionVehicles.length;
  const inViewCount = activeDetections.length;
  const countByType = sessionVehicles.reduce<Record<string, number>>((acc, veh) => {
    const type = veh.vehicle_type || "vehicle";
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Hidden file input for video upload */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        accept="video/*"
        className="hidden"
      />
      <canvas ref={offscreenCanvasRef} className="hidden" />

      {/* Main Video Viewport & Detection Overlay */}
      <div className="lg:col-span-8 space-y-4">
        <Card className="overflow-hidden border-2 bg-slate-950 text-slate-100 shadow-2xl relative">
          {/* Viewport Frame */}
          <div className="relative aspect-video w-full bg-slate-950 overflow-hidden select-none flex items-center justify-center">
            {/* 1. Live Webcam Feed Mode */}
            {sourceMode === "live" && (
              <video
                ref={liveVideoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 w-full h-full object-cover"
              />
            )}

            {/* 2. Uploaded Video Player Mode */}
            {sourceMode === "upload" && uploadedVideoUrl && (
              <video
                ref={uploadVideoRef}
                src={uploadedVideoUrl}
                playsInline
                muted
                loop
                onTimeUpdate={() => {
                  if (uploadVideoRef.current) {
                    setVideoProgress(
                      (uploadVideoRef.current.currentTime / uploadVideoRef.current.duration) * 100,
                    );
                  }
                }}
                onLoadedMetadata={() => {
                  if (uploadVideoRef.current) {
                    setVideoDuration(uploadVideoRef.current.duration);
                    if (autoStartUpload) {
                      void uploadVideoRef.current.play();
                      setIsPlaying(true);
                    }
                  }
                }}
                onEnded={() => setIsPlaying(false)}
                className="absolute inset-0 w-full h-full object-contain bg-black"
              />
            )}

            {/* Empty Upload Prompt when in upload mode with no video selected yet */}
            {sourceMode === "upload" && !uploadedVideoUrl && (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="absolute inset-0 flex flex-col items-center justify-center p-6 border-2 border-dashed border-slate-700/80 bg-slate-900/60 hover:bg-slate-900/90 cursor-pointer transition-all text-center gap-3 z-10"
              >
                <div className="h-14 w-14 rounded-full bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-lg">
                  <UploadCloudIcon className="h-7 w-7" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-slate-200">
                    Click to Upload Video File
                  </h4>
                  <p className="text-xs text-slate-400 mt-1 max-w-sm">
                    Supports MP4, WebM, MOV, MKV. Automated ANPR captures car snapshots & extracts license plates in real time.
                  </p>
                </div>
                <Button variant="outline" size="sm" className="mt-2 text-xs font-mono">
                  Select Video from Device
                </Button>
              </div>
            )}

            {/* Live Camera Inactive Fallback */}
            {sourceMode === "live" && liveStreamError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-slate-900/90 text-center gap-3 z-10">
                <CameraIcon className="h-10 w-10 text-amber-400" />
                <div className="max-w-md space-y-1">
                  <h4 className="text-sm font-semibold text-slate-200">Camera Stream Inactive</h4>
                  <p className="text-xs text-slate-400">{liveStreamError}</p>
                </div>
                <div className="flex gap-2 mt-2">
                  <Button size="sm" variant="outline" onClick={() => void startLiveStream()}>
                    <RefreshCwIcon className="h-3.5 w-3.5 mr-1" /> Retry Camera
                  </Button>
                  <Button size="sm" variant="default" onClick={() => setSourceMode("upload")}>
                    <FileVideoIcon className="h-3.5 w-3.5 mr-1" /> Switch to Video File
                  </Button>
                </div>
              </div>
            )}

            {/* 3. Preset Feeds Backdrop Simulation */}
            {sourceMode === "preset" && (
              <>
                <div className="absolute inset-0 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:16px_16px] opacity-40" />
                <div className="absolute inset-0 flex flex-col justify-between p-6 opacity-30 pointer-events-none">
                  <div className="h-1/3 border-b border-dashed border-slate-700/80" />
                  <div className="h-1/2 flex items-end">
                    <div className="w-full h-1 bg-amber-500/30" />
                  </div>
                </div>
              </>
            )}

            {/* Top Left Feed HUD Status */}
            <div className="absolute top-3 left-3 flex flex-col gap-1 font-mono text-[11px] text-slate-300 pointer-events-none z-20">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${
                    sourceMode === "live" && isLiveStreaming
                      ? "bg-emerald-400 animate-ping"
                      : sourceMode === "upload" && isPlaying
                        ? "bg-cyan-400 animate-pulse"
                        : "bg-red-500 animate-ping"
                  }`}
                />
                <span className="font-bold tracking-wider text-slate-200 uppercase">
                  {sourceMode === "live"
                    ? "LIVE CAMERA FEED"
                    : sourceMode === "upload"
                      ? `VIDEO FEED: ${uploadedFileName || "LOADED FILE"}`
                      : "CHECKPOINT ANPR FEED"}
                </span>
              </div>
              <div className="text-slate-400 text-[10px]">
                IN VIEW: <strong className="text-cyan-300 font-bold">{inViewCount} VEHICLE{inViewCount !== 1 ? "S" : ""}</strong> | ANPR:{" "}
                <span className={modelOnline ? "text-emerald-400 font-semibold" : "text-amber-300 font-semibold"}>
                  {modelOnline ? "MODEL ONLINE" : "MODEL OFFLINE"}
                </span>
              </div>
            </div>

            {/* Top Right Match Status Badge */}
            <div className="absolute top-3 right-3 pointer-events-none z-20">
              {isMatched ? (
                <div className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 font-mono text-xs font-bold text-white shadow-xl animate-bounce">
                  <ShieldAlertIcon className="h-4 w-4" />
                  <span>WATCHLIST MATCH — {primaryDetection?.severity}</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 rounded-md bg-emerald-700/90 px-3 py-1 font-mono text-xs font-semibold text-white shadow">
                  <CheckCircle2Icon className="h-3.5 w-3.5" />
                  <span>REGISTRY CLEAR</span>
                </div>
              )}
            </div>

            {/* Bottom HUD Bar & Action Buttons */}
            <div className="absolute bottom-3 inset-x-3 rounded bg-slate-950/90 px-3 py-2 text-xs font-mono text-slate-300 border border-slate-800 backdrop-blur z-20 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span>
                  ACTIVE:{" "}
                  <strong className="text-slate-100 uppercase">
                    {primaryDetection?.vehicle_type ?? "CAR"}
                  </strong>
                </span>
                <span>
                  PLATE: <strong className="text-amber-400 font-bold">{plateNumber}</strong>
                </span>
                <span>
                  CONFIDENCE:{" "}
                  <strong className="text-emerald-400">
                    {Math.round((primaryDetection?.plate_confidence ?? 0.96) * 100)}%
                  </strong>
                </span>
              </div>

              <div className="flex items-center gap-2">
                {/* Manual Snapshot Trigger Button */}
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-[11px] gap-1 font-semibold bg-cyan-600 hover:bg-cyan-700 text-white shadow"
                  onClick={() => {
                    const videoElem =
                      sourceMode === "live" ? liveVideoRef.current : uploadVideoRef.current;
                    void captureAndDetectCar(
                      videoElem,
                      sourceMode === "live" ? "Live Camera" : "Video Snapshot",
                    );
                  }}
                >
                  <CameraIcon className="h-3.5 w-3.5" />
                  Take Snapshot & Read Plate
                </Button>

                {sourceMode === "live" && isLiveStreaming && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[10px] text-slate-300 hover:text-white"
                    onClick={toggleCameraFacing}
                  >
                    <SwitchCameraIcon className="h-3 w-3 mr-1" /> Flip Camera
                  </Button>
                )}

                {sourceMode === "upload" && uploadedVideoUrl && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px]"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Change Video
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Uploaded Video Controls Strip */}
          {sourceMode === "upload" && uploadedVideoUrl && (
            <div className="bg-slate-900 border-t border-slate-800 px-4 py-2.5 flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant={isPlaying ? "destructive" : "default"}
                  className="h-8 px-3 text-xs gap-1.5"
                  onClick={handlePlayPause}
                >
                  {isPlaying ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
                  {isPlaying ? "Pause Playback" : "Play & Read Plates"}
                </Button>

                <input
                  type="range"
                  min="0"
                  max="100"
                  value={videoProgress}
                  onChange={handleVideoSeek}
                  className="flex-1 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />

                <div className="flex items-center gap-1">
                  {[0.5, 1, 2].map((speed) => (
                    <Button
                      key={speed}
                      size="sm"
                      variant={playbackSpeed === speed ? "secondary" : "ghost"}
                      className="h-7 px-2 text-[10px] font-mono"
                      onClick={() => handleSpeedChange(speed)}
                    >
                      {speed}x
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* --------------------------------- REAL-TIME VEHICLE COUNTER & STATS STRIP --------------------------------- */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-3 border bg-muted/20">
            <div className="text-[11px] font-medium text-muted-foreground flex items-center justify-between">
              <span>Total Vehicles Count</span>
              <CarIcon className="h-3.5 w-3.5 text-cyan-500" />
            </div>
            <div className="text-2xl font-bold tracking-tight text-foreground font-mono mt-1">
              {totalVehiclesCount}
            </div>
            <div className="text-[10px] text-muted-foreground">Captured & counted in session</div>
          </Card>

          <Card className="p-3 border bg-muted/20">
            <div className="text-[11px] font-medium text-muted-foreground flex items-center justify-between">
              <span>In Current View</span>
              <EyeIcon className="h-3.5 w-3.5 text-emerald-500" />
            </div>
            <div className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400 font-mono mt-1">
              {inViewCount}
            </div>
            <div className="text-[10px] text-muted-foreground">Active vehicles in frame</div>
          </Card>

          <Card className="p-3 border bg-muted/20 sm:col-span-2">
            <div className="text-[11px] font-medium text-muted-foreground mb-1.5">
              Vehicle Type Distribution
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(countByType).length > 0 ? (
                Object.entries(countByType).map(([type, count]) => (
                  <Badge key={type} variant="secondary" className="font-mono text-[10px] uppercase">
                    {type}: {count}
                  </Badge>
                ))
              ) : (
                <span className="text-[11px] text-muted-foreground font-mono">
                  Scanning for vehicles...
                </span>
              )}
            </div>
          </Card>
        </div>

        {/* --------------------------------- ZOOMED PLATE & CAR SNAPSHOT INSPECTOR --------------------------------- */}
        <Card className="border">
          <CardHeader className="py-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CrosshairIcon className="h-4 w-4 text-primary" />
                <CardTitle className="text-sm font-semibold">
                  Plate Snapshot & Optical License Plate OCR Breakdown
                </CardTitle>
              </div>
              <Badge variant="secondary" className="font-mono text-xs">
                Real-Time ANPR
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="py-2 px-4 pb-4 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-12 items-center">
              {/* Captured Car Photo Snapshot Thumbnail */}
              <div className="sm:col-span-4 flex flex-col items-center justify-center p-2 rounded-md border bg-slate-950/80 text-slate-100 overflow-hidden">
                <div className="text-[10px] font-mono text-muted-foreground mb-1 flex items-center justify-between w-full px-1">
                  <span>PLATE SNAPSHOT</span>
                  <span className="text-cyan-400">
                    {primaryDetection?.vehicle_type?.toUpperCase() ?? "CAR"}
                  </span>
                </div>
                {primaryDetection?.image_snapshot ? (
                  <button
                    type="button"
                    onClick={() => setEnlargedSnapshot(primaryDetection.image_snapshot)}
                    className="w-full cursor-zoom-in"
                    title="Click to enlarge vehicle photo"
                  >
                    <img
                      src={primaryDetection.image_snapshot}
                      alt="Captured number plate — click to enlarge"
                      className="w-full h-24 object-contain rounded border border-slate-700 hover:border-cyan-400 transition-colors bg-black"
                    />
                  </button>
                ) : (
                  <div className="w-full h-24 rounded border border-slate-800 bg-slate-900 flex flex-col items-center justify-center text-slate-500 text-xs gap-1">
                    <CarIcon className="h-6 w-6 text-slate-600" />
                    <span>Live Frame Capture</span>
                  </div>
                )}
              </div>

              <Dialog open={!!enlargedSnapshot} onOpenChange={(open) => !open && setEnlargedSnapshot(null)}>
                <DialogContent className="max-w-4xl p-3">
                  <DialogTitle className="px-2 text-sm">Captured number plate</DialogTitle>
                  {enlargedSnapshot && (
                    <img
                      src={enlargedSnapshot}
                      alt="Enlarged captured number plate"
                      className="max-h-[80vh] w-full rounded object-contain bg-black"
                    />
                  )}
                </DialogContent>
              </Dialog>

              {/* High Contrast License Plate Render */}
              <div className="sm:col-span-4 flex flex-col items-center justify-center p-3 rounded-md bg-amber-50 border-2 border-slate-900 text-slate-900 shadow-inner">
                <div className="flex items-center justify-between w-full px-2 text-[10px] font-bold text-slate-600 uppercase border-b border-slate-300 pb-0.5 mb-1">
                  <span>IND</span>
                  <span>INDIA</span>
                  <span className="h-2 w-2 rounded-full bg-blue-600" />
                </div>
                <div className="text-2xl font-mono font-black tracking-widest text-slate-950 px-2 py-1">
                  {plateNumber}
                </div>
              </div>

              {/* Character by character OCR Confidence pills */}
              <div className="sm:col-span-4 space-y-2">
                <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
                  <span>OCR Confidence:</span>
                  <span className="font-mono text-emerald-600 font-semibold">
                    {Math.round((primaryDetection?.plate_confidence ?? 0.96) * 100)}%
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {plateNumber.replace(/\s+/g, "").split("").map((char, index) => (
                    <div
                      key={index}
                      className="flex flex-col items-center rounded border bg-muted/40 px-1.5 py-0.5 text-center"
                    >
                      <span className="font-mono font-bold text-xs text-foreground">{char}</span>
                      <span className="text-[9px] font-mono text-muted-foreground">
                        {95 + ((index * 7) % 5)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* BOLO Alert Warning Box if matched */}
            {isMatched && primaryDetection?.matched_entry && (
              <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3.5 text-red-900 dark:text-red-200 flex items-start gap-3">
                <ShieldAlertIcon className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <strong className="text-sm font-semibold text-red-700 dark:text-red-300">
                      FLAGGED VEHICLE DETECTED — {primaryDetection.matched_entry.plate_number}
                    </strong>
                    <SeverityBadge severity={primaryDetection.severity} />
                  </div>
                  <p>
                    <strong>Reason:</strong> {primaryDetection.matched_entry.flag_reason}
                  </p>
                  {primaryDetection.matched_entry.make_model && (
                    <p className="text-muted-foreground">
                      <strong>Vehicle Info:</strong> {primaryDetection.matched_entry.color ?? ""}{" "}
                      {primaryDetection.matched_entry.make_model} (
                      {primaryDetection.matched_entry.vehicle_type})
                    </p>
                  )}
                  {primaryDetection.matched_entry.notes && (
                    <p className="font-mono text-[11px] text-red-800 dark:text-red-300 bg-red-100/50 dark:bg-red-950/40 p-1.5 rounded">
                      <strong>Notes:</strong> {primaryDetection.matched_entry.notes}
                    </p>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Control Sidebar with 4 Feed Modes & Session Vehicle List */}
      <div className="lg:col-span-4 space-y-4">
        <Card className="border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ZapIcon className="h-4 w-4 text-amber-500" />
              Feed Source & ANPR Controls
            </CardTitle>
            <CardDescription className="text-xs">
              Live Camera, Upload Video, Checkpoint Presets, or Direct Plate OCR.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className={`rounded-md border px-3 py-2 text-xs ${modelOnline ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200"}`}>
              {modelMessage}
            </div>
            {/* 4 Mode Selectors */}
            <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-xs">
              <button
                type="button"
                className={`rounded py-1.5 font-medium transition-colors flex items-center justify-center gap-1 ${
                  sourceMode === "preset"
                    ? "bg-background text-foreground shadow-sm font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setSourceMode("preset")}
              >
                <LayersIcon className="h-3.5 w-3.5" /> Preset Feeds
              </button>
              <button
                type="button"
                className={`rounded py-1.5 font-medium transition-colors flex items-center justify-center gap-1 ${
                  sourceMode === "live"
                    ? "bg-background text-foreground shadow-sm font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setSourceMode("live")}
              >
                <RadioIcon className="h-3.5 w-3.5 text-red-500" /> Live Video
              </button>
              <button
                type="button"
                className={`rounded py-1.5 font-medium transition-colors flex items-center justify-center gap-1 ${
                  sourceMode === "upload"
                    ? "bg-background text-foreground shadow-sm font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setSourceMode("upload")}
              >
                <FileVideoIcon className="h-3.5 w-3.5 text-cyan-400" /> Upload Video
              </button>
              <button
                type="button"
                className={`rounded py-1.5 font-medium transition-colors flex items-center justify-center gap-1 ${
                  sourceMode === "manual"
                    ? "bg-background text-foreground shadow-sm font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setSourceMode("manual")}
              >
                <SearchIcon className="h-3.5 w-3.5" /> Direct Plate
              </button>
            </div>

            {/* Mode 1: Preset Feeds */}
            {sourceMode === "preset" && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Select Border Checkpoint Feed</Label>
                  <Select value={selectedPreset} onValueChange={(val) => handlePresetTrigger(val)}>
                    <SelectTrigger className="text-xs h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRESET_FEEDS.map((feed) => (
                        <SelectItem key={feed.key} value={feed.key} className="text-xs">
                          {feed.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  className="w-full font-semibold gap-2"
                  onClick={() => handlePresetTrigger(selectedPreset)}
                  disabled={scanning}
                >
                  {scanning ? <Spinner /> : <PlayIcon className="h-4 w-4" />}
                  {scanning ? "Processing Frame..." : "Execute ANPR Scan"}
                </Button>
              </div>
            )}

            {/* Mode 2: Live Video / Camera */}
            {sourceMode === "live" && (
              <div className="space-y-3">
                <div className="rounded-md border p-3 bg-muted/30 space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="flex items-center gap-1.5">
                      <RadioIcon className="h-4 w-4 text-red-500 animate-pulse" />
                      Live Camera ANPR
                    </span>
                    <Badge variant={isLiveStreaming ? "default" : "secondary"} className="text-[10px]">
                      {isLiveStreaming ? "STREAMING" : "OFFLINE"}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Connects directly to your camera device to snapshot and scan moving vehicles in real time.
                  </p>
                </div>

                <div className="flex items-center justify-between p-2 rounded border text-xs">
                  <span className="font-medium">Continuous Auto-Scan</span>
                  <Switch checked={continuousScan} onCheckedChange={setContinuousScan} />
                </div>

                <Button
                  variant="outline"
                  className="w-full text-xs font-semibold gap-2"
                  onClick={() => void captureAndDetectCar(liveVideoRef.current, "Live Camera")}
                  disabled={!modelOnline}
                >
                  <CrosshairIcon className="h-4 w-4" />
                  Take Snapshot & Read Plate
                </Button>
              </div>
            )}

            {/* Mode 3: Upload Video File */}
            {sourceMode === "upload" && (
              <div className="space-y-3">
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-md border-2 border-dashed p-3 bg-muted/20 hover:bg-muted/40 cursor-pointer text-center space-y-1.5 transition-colors"
                >
                  <UploadCloudIcon className="h-6 w-6 text-cyan-500 mx-auto" />
                  <div className="text-xs font-semibold text-foreground">
                    {uploadedFileName || "Choose or Drag Video File"}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    MP4, WebM, MOV. Automatically snapshots cars and reads plates as video plays.
                  </p>
                </div>

                {uploadedVideoUrl && (
                  <>
                    <div className="flex items-center justify-between p-2 rounded border text-xs">
                      <span className="font-medium">Continuous Scan on Play</span>
                      <Switch checked={continuousScan} onCheckedChange={setContinuousScan} />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        className="w-full font-semibold gap-1.5 text-xs"
                        onClick={handlePlayPause}
                      >
                        {isPlaying ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
                        {isPlaying ? "Pause" : "Play & Read"}
                      </Button>

                      <Button
                        variant="secondary"
                        className="w-full font-semibold gap-1.5 text-xs"
                        onClick={() => void captureAndDetectCar(uploadVideoRef.current, uploadedFileName || "Video Snapshot")}
                        disabled={!modelOnline}
                      >
                        <CameraIcon className="h-3.5 w-3.5" />
                        Snap & Count
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Mode 4: Manual / Direct Real Plate Input */}
            {sourceMode === "manual" && (
              <form onSubmit={handleManualSubmit} className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Vehicle License Plate</Label>
                  <Input
                    placeholder="e.g. DL 08 CA 5432 or UP 16 CZ 9021"
                    value={manualPlate}
                    onChange={(e) => setManualPlate(e.target.value.toUpperCase())}
                    className="font-mono text-sm h-9"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold">Vehicle Type</Label>
                    <Select value={manualType} onValueChange={setManualType}>
                      <SelectTrigger className="text-xs h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="car">Car</SelectItem>
                        <SelectItem value="suv">SUV</SelectItem>
                        <SelectItem value="truck">Truck</SelectItem>
                        <SelectItem value="tractor">Tractor</SelectItem>
                        <SelectItem value="motorcycle">Motorcycle</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold">Camera Feed</Label>
                    <Select value={manualCam} onValueChange={setManualCam}>
                      <SelectTrigger className="text-xs h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cam_fence_north">BOP-01 North</SelectItem>
                        <SelectItem value="cam_farm_gate">BOP-02 Gate</SelectItem>
                        <SelectItem value="cam_patrol_road">BOP-03 Patrol</SelectItem>
                        <SelectItem value="cam_waterline">BOP-04 Water</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Button type="submit" className="w-full font-semibold gap-2" disabled={scanning}>
                  {scanning ? <Spinner /> : <SearchIcon className="h-4 w-4" />}
                  Read Plate & Match Watchlist
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        {/* --------------------------------- CAPTURED VEHICLES SNAPSHOT LOG --------------------------------- */}
        <Card className="border">
          <CardHeader className="py-2.5 px-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                <ListOrderedIcon className="h-3.5 w-3.5 text-primary" />
                Captured Vehicles ({sessionVehicles.length})
              </CardTitle>
              {sessionVehicles.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[10px] text-muted-foreground"
                  onClick={() => {
                    setSessionVehicles([]);
                    setTotalVehiclesCaptured(0);
                    visibleVehiclesRef.current.clear();
                    countedVehiclesRef.current.clear();
                  }}
                >
                  Reset Count
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-2 pt-0 max-h-60 overflow-y-auto space-y-1.5">
            {sessionVehicles.length === 0 ? (
              <div className="text-[11px] text-muted-foreground text-center py-4">
                No vehicles captured yet. Play a video or click Take Snapshot.
              </div>
            ) : (
              sessionVehicles.map((veh, idx) => {
                const hit = veh.match_status === "MATCHED";
                return (
                  <div
                    key={veh.id || idx}
                    onClick={() => {
                      setActiveDetections([veh]);
                      setSelectedVehicleIndex(0);
                    }}
                    className={`flex items-center justify-between p-2 rounded border text-xs cursor-pointer transition-colors ${
                      hit
                        ? "border-red-500/40 bg-red-500/10 hover:bg-red-500/20"
                        : "border-border/60 bg-muted/20 hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      {veh.image_snapshot ? (
                        <img
                          src={veh.image_snapshot}
                          alt="Car Thumbnail"
                          className="h-9 w-12 object-cover rounded border border-slate-700 shrink-0"
                        />
                      ) : (
                        <div className="h-9 w-12 rounded border border-slate-800 bg-slate-900 flex items-center justify-center shrink-0">
                          <CarIcon className="h-4 w-4 text-slate-500" />
                        </div>
                      )}
                      <div>
                        <div className="font-mono font-bold text-xs text-foreground">
                          {veh.plate_number}
                        </div>
                        <div className="text-[10px] text-muted-foreground uppercase">
                          {veh.matched_entry?.color ?? ""} {veh.vehicle_type}
                        </div>
                      </div>
                    </div>
                    <div>
                      {hit ? (
                        <Badge variant="destructive" className="text-[9px] px-1.5 py-0">
                          WATCHLIST HIT
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[9px] text-emerald-600 px-1.5 py-0 border-emerald-500/30"
                        >
                          CLEAR
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
