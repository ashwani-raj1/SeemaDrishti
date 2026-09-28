import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CameraIcon,
  CarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CrosshairIcon,
  Grid3X3Icon,
  ListOrderedIcon,
  Maximize2Icon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SeverityBadge } from "@/components/ibvap/badges";
import { CameraFeed } from "@/components/ibvap/camera-feed";
import { useClient } from "@/client/context";
import { formatPlate } from "@/lib/format";
import { api } from "@/lib/api";
import { onLive, type AnprExtra } from "@/lib/live";
import { onStream } from "@/lib/stream";
import { useResource } from "@/lib/use-resource";
import type { PlateDetection, WatchlistEntry } from "@/lib/types";

function isDisplayableSnapshot(value: string | null | undefined): value is string {
  return Boolean(
    value && (
      value.startsWith("data:image/") ||
      value.startsWith("blob:") ||
      value.startsWith("http://") ||
      value.startsWith("https://") ||
      value.startsWith("/")
    ),
  );
}

function normalizedPlate(value: string | null | undefined): string {
  return (value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

const INDIA_STATE_CODES = new Set([
  "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ",
  "HP", "HR", "JH", "JK", "KA", "KL", "LA", "LD", "MH", "ML", "MN", "MP",
  "MZ", "NL", "OD", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UK", "UP", "WB",
]);

function plateJurisdiction(value: string | null | undefined): { code: string; label: string; verified: boolean } {
  const plate = normalizedPlate(value);
  if (/^\d{2}BH\d{4}[A-Z]{1,2}$/.test(plate)) {
    return { code: "IND", label: "BH SERIES", verified: true };
  }
  const match = plate.match(/^([A-Z]{2})\d{1,2}[A-Z]{1,3}\d{1,4}$/);
  if (match && INDIA_STATE_CODES.has(match[1]!)) {
    return { code: "IND", label: "INDIA", verified: true };
  }
  return { code: "—", label: "UNVERIFIED FORMAT", verified: false };
}

function vehicleTypeLabel(value: string | null | undefined): string {
  const type = (value ?? "vehicle").toLowerCase();
  const labels: Record<string, string> = {
    sedan: "Car · Sedan",
    hatchback: "Car · Hatchback",
    suv: "Car · SUV",
    jeep: "Car · Jeep",
    pickup: "Commercial · Pickup",
    van: "Commercial · Van",
    minivan: "Car · Minivan",
    motorcycle: "Two-wheeler · Motorcycle",
    scooter: "Two-wheeler · Scooter",
    two_wheeler: "Two-wheeler · subtype unverified",
    auto_rickshaw: "Three-wheeler · Auto-rickshaw",
    bus: "Commercial · Bus",
    truck: "Commercial · Truck",
    tractor: "Agricultural · Tractor",
    car: "Car · body style unverified",
    vehicle: "Vehicle · subtype unverified",
  };
  return labels[type] ?? type.replaceAll("_", " ");
}

function likelySameVehicle(previous: PlateDetection, current: PlateDetection): boolean {
  if (previous.camera_id !== current.camera_id || previous.vehicle_type !== current.vehicle_type) return false;
  const age = Math.abs(Date.parse(current.occurred_at) - Date.parse(previous.occurred_at));
  const previousPlate = normalizedPlate(previous.plate_number);
  const currentPlate = normalizedPlate(current.plate_number);
  if (previousPlate && currentPlate && previousPlate === currentPlate) return age <= 20_000;
  if (age > 3_000) return false;

  const [ax1, ay1, ax2, ay2] = previous.bbox;
  const [bx1, by1, bx2, by2] = current.bbox;
  const intersection = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1)) *
    Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const areaA = Math.max(0.0001, (ax2 - ax1) * (ay2 - ay1));
  const areaB = Math.max(0.0001, (bx2 - bx1) * (by2 - by1));
  const overlap = intersection / Math.max(0.0001, areaA + areaB - intersection);
  const centreDistance = Math.hypot(
    (ax1 + ax2 - bx1 - bx2) / 2,
    (ay1 + ay2 - by1 - by2) / 2,
  );
  const sizeRatio = Math.max(areaA, areaB) / Math.min(areaA, areaB);
  return overlap >= 0.35 || (centreDistance <= 0.06 && sizeRatio <= 1.8);
}

function mergeVehicleEvidence(previous: PlateDetection, current: PlateDetection): PlateDetection {
  const currentHasPlate = Boolean(normalizedPlate(current.plate_number));
  const currentIsAuthoritative = currentHasPlate && current.plate_verified !== false;
  const keepPreviousPlate = !currentIsAuthoritative && Boolean(previous.plate_number) &&
    normalizedPlate(previous.plate_number) !== normalizedPlate(current.plate_number);
  return {
    ...current,
    id: previous.id,
    plate_number: keepPreviousPlate ? previous.plate_number : current.plate_number,
    plate_confidence: keepPreviousPlate ? previous.plate_confidence : current.plate_confidence,
    plate_source: keepPreviousPlate ? previous.plate_source : current.plate_source,
    plate_verified: keepPreviousPlate ? previous.plate_verified : current.plate_verified,
    matched_watchlist_id: keepPreviousPlate ? previous.matched_watchlist_id : current.matched_watchlist_id,
    matched_entry: keepPreviousPlate ? previous.matched_entry : current.matched_entry,
    match_status: keepPreviousPlate ? previous.match_status : current.match_status,
    severity: keepPreviousPlate ? previous.severity : current.severity,
    image_snapshot: isDisplayableSnapshot(current.image_snapshot)
      ? current.image_snapshot
      : previous.image_snapshot,
  };
}

interface PlateScannerCanvasProps {
  detection: PlateDetection | null;
  /** Durable OCR records captured since local midnight. */
  todayDetections?: PlateDetection[];
  /** Durable vehicle count for today in the current all/single-camera scope. */
  todayVehicleTotal?: number;
  /** Durable vehicle type totals for today in the current scope. */
  todayVehicleTypes?: Record<string, number>;
  onManualScan: (detection: PlateDetection) => void;
  onVehicleCounted?: (vehicle: {
    sourceKey: string;
    cameraId: string;
    vehicleType: string;
    occurredAt: string;
  }) => void;
  /** Count a stable track when first seen instead of waiting for it to exit. */
  countOnFirstDetection?: boolean;
  /** Optional analytics card placed below the captured-vehicle rail. */
  trafficPanel?: ReactNode;
  /** Operational panel aligned with the OCR breakdown on the right. */
  incidentsPanel?: ReactNode;
  /** Keeps parent analytics scoped to either the full wall or one camera. */
  onCameraScopeChange?: (cameraId: string | null, label: string) => void;
}

interface CameraSessionState {
  vehicles: PlateDetection[];
  total: number;
}

const ANPR_SESSION_STORAGE_KEY = "ibvap.anpr.camera-sessions.v1";
const CAPTURE_RETENTION_MS = 12 * 60 * 60 * 1_000;

function withinCaptureRetention(vehicle: PlateDetection, now = Date.now()): boolean {
  const occurred = Date.parse(vehicle.occurred_at);
  return Number.isFinite(occurred) && now - occurred <= CAPTURE_RETENTION_MS;
}

function loadCameraSessions(): Record<string, CameraSessionState> {
  try {
    const raw = window.localStorage.getItem(ANPR_SESSION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CameraSessionState>;
    if (!parsed || typeof parsed !== "object") return {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(parsed).map(([cameraId, session]) => [
      cameraId,
      { ...session, vehicles: (session.vehicles ?? []).filter((vehicle) => withinCaptureRetention(vehicle, now)) },
    ]));
  } catch {
    return {};
  }
}

function saveCameraSessions(sessions: Record<string, CameraSessionState>) {
  try {
    const now = Date.now();
    // This workbench is a rolling operational window. Complete durable plate
    // history remains in the backend ANPR log beyond these twelve hours.
    const bounded = Object.fromEntries(Object.entries(sessions).map(([cameraId, session]) => [
      cameraId,
      { ...session, vehicles: session.vehicles.filter((vehicle) => withinCaptureRetention(vehicle, now)) },
    ]));
    window.localStorage.setItem(ANPR_SESSION_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Storage can be disabled or full. Live detection must continue working.
  }
}

export function PlateScannerCanvas({
  detection: _initialDetection,
  todayDetections = [],
  todayVehicleTotal,
  todayVehicleTypes = {},
  onManualScan,
  onVehicleCounted,
  countOnFirstDetection = false,
  trafficPanel,
  incidentsPanel,
  onCameraScopeChange,
}: PlateScannerCanvasProps) {
  const { media } = useClient();
  const [searchParams] = useSearchParams();
  const cameraHub = useResource(() => api.mediaCameras(), []);
  const cameras = cameraHub.data?.cameras ?? [];
  const [sourceMode, setSourceMode] = useState<"camera" | "live">("camera");
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [cameraWallOpen, setCameraWallOpen] = useState(true);
  const [cameraWallPage, setCameraWallPage] = useState(0);
  const [, setCameraWallRevision] = useState(0);
  const [feedClock, setFeedClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setFeedClock(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // Media readiness changes independently of the React page. Poll the hub so
  // an offline tile cannot keep saying Offline while fresh detections arrive,
  // and a stopped hub cannot keep a stale Live badge.
  useEffect(() => {
    const timer = window.setInterval(cameraHub.reload, 5_000);
    return () => window.clearInterval(timer);
  }, [cameraHub.reload]);

  // Multi-vehicle detections in current frame
  const [activeDetections, setActiveDetections] = useState<PlateDetection[]>([]);
  // Currently selected / highlighted vehicle for zoom inspection
  const [selectedVehicleIndex, setSelectedVehicleIndex] = useState<number>(0);

  // Session vehicle accumulator and vehicle count stats
  const [sessionVehicles, setSessionVehicles] = useState<PlateDetection[]>([]);
  const [totalVehiclesCaptured, setTotalVehiclesCaptured] = useState<number>(0);
  // Live workbench state is deliberately memory-only. Durable history belongs
  // to the ANPR Logs tab; restoring it here makes an empty road look occupied.
  const cameraSessionsRef = useRef<Record<string, CameraSessionState>>(loadCameraSessions());
  const selectedCameraIdRef = useRef("");
  const activeSessionCameraRef = useRef("");
  const hydratingCameraRef = useRef<string | null>(null);

  // Live Video / Webcam State
  const [isLiveStreaming, setIsLiveStreaming] = useState(false);
  const [liveStreamError, setLiveStreamError] = useState<string | null>(null);
  const [modelOnline, setModelOnline] = useState(false);
  const [modelMessage, setModelMessage] = useState("Checking local ANPR model…");
  const [enlargedSnapshot, setEnlargedSnapshot] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("environment");
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const sharedCameraViewportRef = useRef<HTMLDivElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const [continuousScan, setContinuousScan] = useState(true);
  const requestedCameraId = searchParams.get("camera") ?? "";
  const requestedPlate = searchParams.get("plate") ?? "";
  const requestedAt = searchParams.get("at") ?? "";

  // Offscreen canvas for actual frame snapshotting & optical processing
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanIntervalRef = useRef<any>(null);
  const analysisInFlightRef = useRef(false);
  const submittedPlatesRef = useRef(new Map<string, number>());
  const alarmedVehiclesRef = useRef(new Set<string>());
  const visibleVehiclesRef = useRef(new Map<string, {
    vehicle: PlateDetection;
    firstSeen: number;
    lastSeen: number;
    hits: number;
  }>());
  const countedVehiclesRef = useRef(new Set<string>());
  const liveDetectionsByCameraRef = useRef<Record<string, PlateDetection[]>>({});
  const liveTrackEvidenceRef = useRef(new Map<string, { hits: number; lastSeen: number }>());
  const trafficSessionRef = useRef(`anpr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const lastSirenAtRef = useRef(0);

  useEffect(() => {
    const persist = () => saveCameraSessions(cameraSessionsRef.current);
    const timer = window.setInterval(persist, 2_000);
    window.addEventListener("beforeunload", persist);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", persist);
      persist();
    };
  }, []);

  const recordCountedVehicle = useCallback((vehicle: PlateDetection, cameraId: string, sharedCamera = false) => {
    // Shared cameras persist their stable track directly from the Vision
    // service. Posting it from the browser as well double-counts one vehicle.
    if (sharedCamera) return;
    onVehicleCounted?.({
      sourceKey: `${trafficSessionRef.current}:${vehicle.id}`,
      cameraId,
      vehicleType: vehicle.vehicle_type || "vehicle",
      occurredAt: vehicle.occurred_at || new Date().toISOString(),
    });
  }, [onVehicleCounted]);

  // Watchlist cache for instant matching
  const watchlistCacheRef = useRef<WatchlistEntry[]>([]);

  useEffect(() => {
    if (requestedCameraId && cameras.some((camera) => camera.id === requestedCameraId)) {
      if (selectedCameraId !== requestedCameraId) setSelectedCameraId(requestedCameraId);
      setCameraWallOpen(false);
      return;
    }
    if (selectedCameraId || cameras.length === 0) return;
    const first = cameras.find((camera) => camera.ready && camera.seeded) ?? cameras[0];
    if (first) setSelectedCameraId(first.id);
  }, [cameras, requestedCameraId, selectedCameraId]);

  useEffect(() => {
    if (!requestedPlate || !requestedCameraId) return;
    let cancelled = false;
    void api.plateDetections({
      plate: requestedPlate,
      camera_id: requestedCameraId,
      limit: 25,
    }).then((detections) => {
      if (cancelled || detections.length === 0) return;
      const targetTime = Date.parse(requestedAt);
      const focused = Number.isFinite(targetTime)
        ? detections.slice().sort((a, b) =>
            Math.abs(Date.parse(a.occurred_at) - targetTime) - Math.abs(Date.parse(b.occurred_at) - targetTime))[0]!
        : detections[0]!;
      const existing = cameraSessionsRef.current[requestedCameraId] ?? { vehicles: [], total: 0 };
      const vehicles = [focused, ...existing.vehicles.filter((vehicle) => vehicle.id !== focused.id)].slice(0, 50);
      cameraSessionsRef.current[requestedCameraId] = {
        vehicles,
        total: Math.max(existing.total, vehicles.length),
      };
      setSessionVehicles(vehicles);
      setTotalVehiclesCaptured(cameraSessionsRef.current[requestedCameraId]!.total);
      setActiveDetections([focused]);
      setSelectedVehicleIndex(0);
    }).catch(() => {
      // The focused camera still opens even if the retained evidence lookup is unavailable.
    });
    return () => {
      cancelled = true;
    };
  }, [requestedAt, requestedCameraId, requestedPlate]);

  useEffect(() => {
    if (!selectedCameraId) return;
    const previousCamera = activeSessionCameraRef.current;
    if (previousCamera) {
      cameraSessionsRef.current[previousCamera] = {
        vehicles: sessionVehicles,
        total: totalVehiclesCaptured,
      };
    }
    selectedCameraIdRef.current = selectedCameraId;
    activeSessionCameraRef.current = selectedCameraId;
    hydratingCameraRef.current = selectedCameraId;
    const saved = cameraSessionsRef.current[selectedCameraId] ?? { vehicles: [], total: 0 };
    setSessionVehicles(saved.vehicles);
    setTotalVehiclesCaptured(saved.total);
    // Captured history is not the current frame. Reusing it here made an empty
    // road say that old vehicles were still visible after switching cameras.
    setActiveDetections(liveDetectionsByCameraRef.current[selectedCameraId] ?? []);
    setSelectedVehicleIndex(0);
  }, [selectedCameraId]);

  useEffect(() => {
    const cameraId = activeSessionCameraRef.current;
    if (!cameraId) return;
    if (hydratingCameraRef.current === cameraId) {
      hydratingCameraRef.current = null;
      return;
    }
    cameraSessionsRef.current[cameraId] = {
      vehicles: sessionVehicles,
      total: totalVehiclesCaptured,
    };
  }, [sessionVehicles, totalVehiclesCaptured]);

  const selectedCamera = cameras.find((camera) => camera.id === selectedCameraId) ?? null;

  useEffect(() => {
    if (cameraWallOpen) {
      onCameraScopeChange?.(null, "All cameras");
      return;
    }
    onCameraScopeChange?.(selectedCameraId || null, selectedCamera?.name ?? "Selected camera");
  }, [cameraWallOpen, onCameraScopeChange, selectedCamera?.name, selectedCameraId]);
  const cameraWallPageSize = 6;
  const cameraWallPages = Math.max(1, Math.ceil(cameras.length / cameraWallPageSize));
  const wallCameras = cameras.slice(
    cameraWallPage * cameraWallPageSize,
    cameraWallPage * cameraWallPageSize + cameraWallPageSize,
  );

  useEffect(() => {
    if (cameraWallPage < cameraWallPages) return;
    setCameraWallPage(Math.max(0, cameraWallPages - 1));
  }, [cameraWallPage, cameraWallPages]);

  useEffect(() => {
    const refreshWatchlist = () => void api.watchlist({ limit: 500 }).then((entries) => {
      watchlistCacheRef.current = entries;
    }).catch(() => {});
    refreshWatchlist();
    const unsubscribe = onStream("watchlist_change", () => {
      refreshWatchlist();
      // A plate already in view must be checked again if the supervisor adds
      // it to the watchlist while the vehicle is still present.
      submittedPlatesRef.current.clear();
    });
    return unsubscribe;
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

  // Every recent durable OCR row is authoritative, not only a watchlist hit.
  // Upgrade the already-counted live track in place so Captured Vehicles,
  // ANPR Logs and the OCR card all describe the same physical vehicle.
  useEffect(() => {
    if (!_initialDetection) return;
    if (Date.now() - Date.parse(_initialDetection.occurred_at) > 30_000) return;

    const cameraId = _initialDetection.camera_id;
    const existing = cameraSessionsRef.current[cameraId] ?? { vehicles: [], total: 0 };
    let sameIndex = existing.vehicles.findIndex((vehicle) =>
      vehicle.id === _initialDetection.id ||
      (normalizedPlate(vehicle.plate_number) && normalizedPlate(vehicle.plate_number) === normalizedPlate(_initialDetection.plate_number)));
    if (sameIndex < 0) {
      sameIndex = existing.vehicles.findIndex((vehicle) =>
        vehicle.camera_id === cameraId &&
        vehicle.vehicle_type === _initialDetection.vehicle_type &&
        Math.abs(Date.parse(vehicle.occurred_at) - Date.parse(_initialDetection.occurred_at)) <= 15_000 &&
        vehicle.plate_verified !== true);
    }
    const previous = sameIndex >= 0 ? existing.vehicles[sameIndex]! : null;
    const durableDetection = previous
      ? { ..._initialDetection, bbox: previous.bbox }
      : _initialDetection;
    const hit = previous ? mergeVehicleEvidence(previous, durableDetection) : durableDetection;
    const vehicles = [hit, ...existing.vehicles.filter((_, index) => index !== sameIndex)].slice(0, 50);
    cameraSessionsRef.current[cameraId] = {
      // A durable OCR acknowledgement upgrades a track; it never counts the
      // same vehicle for a second time.
      total: previous ? existing.total : Math.max(existing.total, vehicles.length),
      vehicles,
    };
    const live = liveDetectionsByCameraRef.current[cameraId] ?? [];
    const liveIndex = live.findIndex((vehicle) =>
      vehicle.id === hit.id ||
      (normalizedPlate(vehicle.plate_number) && normalizedPlate(vehicle.plate_number) === normalizedPlate(hit.plate_number)) ||
      (vehicle.vehicle_type === hit.vehicle_type &&
        Math.abs(Date.parse(vehicle.occurred_at) - Date.parse(hit.occurred_at)) <= 15_000));
    if (liveIndex >= 0) {
      liveDetectionsByCameraRef.current[cameraId] = live.map((vehicle, index) =>
        index === liveIndex ? mergeVehicleEvidence(vehicle, { ...hit, bbox: vehicle.bbox }) : vehicle);
    }
    if (selectedCameraIdRef.current === cameraId) {
      setSessionVehicles(cameraSessionsRef.current[cameraId]!.vehicles);
      setActiveDetections(liveDetectionsByCameraRef.current[cameraId] ?? []);
    }
    setCameraWallRevision((revision) => revision + 1);
    if (hit.match_status === "MATCHED" && !alarmedVehiclesRef.current.has(hit.id)) {
      alarmedVehiclesRef.current.add(hit.id);
      playWatchlistSiren();
    }
  }, [_initialDetection, playWatchlistSiren]);

  useEffect(() => {
    // The shared vision service watches every camera continuously. Keep one
    // lightweight subscription per camera so switching views never pauses or
    // resets another camera's counter.
    if (cameras.length === 0) return;
    const unsubscribers = cameras
      // Keep the selected camera subscribed too. Single-camera mode may use
      // the local HTTP OCR helper when it is available, but the shared Vision
      // stream remains the authoritative fallback and must never be cut off.
      .filter((camera) => camera.ready)
      .map((camera) => onLive(camera.id, "anpr", (observation) => {
      const at = new Date().toISOString();
      const rawNext = observation.tracks
        // Night footage and vehicles clipped by a frame edge often score in
        // the 0.30s. Multi-frame confirmation below removes one-frame noise;
        // rejecting these here made a clearly visible bus disappear entirely.
        .filter((track) => track.confidence >= 0.30)
        .map((track, index): PlateDetection => {
        const extra = track.extra as AnprExtra;
        // Show the live OCR/Gemini hint immediately, but keep it explicitly
        // unverified. Only the backend's durable plate_read can persist it,
        // compare it with the watchlist or raise an incident.
        const plate = normalizedPlate(extra.plate?.text);
        // This websocket carries live, explicitly unconfirmed OCR observations.
        // It may draw text, but only the durable backend plate_read is allowed
        // to match a watchlist or raise an alarm -- so this is never a match,
        // by design, not a placeholder for logic that got skipped.
        return {
          id: extra.track_ref ?? `${camera.id}:${track.track_id ?? index}`,
          org_id: "org_bsf",
          camera_id: camera.id,
          camera_name: camera.name,
          zone_id: null,
          plate_number: plate,
          vehicle_type: extra.vehicle_type ?? track.class ?? "vehicle",
          confidence: track.confidence,
          plate_confidence: extra.plate?.confidence ?? 0,
          plate_source: extra.plate?.source ?? "ocr",
          matched_watchlist_id: null,
          matched_entry: null,
          plate_verified: false,
          match_status: "UNVERIFIED" as const,
          severity: "INFO" as const,
          bbox: track.bbox,
          plate_bbox: extra.plate?.bbox ?? [0, 0, 0, 0],
          image_snapshot: extra.plate?.image_snapshot ?? extra.image_snapshot ?? null,
          simulated: false,
          occurred_at: at,
          created_at: at,
        };
      });

      const observedAt = Date.now();
      for (const vehicle of rawNext) {
        const key = `${camera.id}:${vehicle.id}`;
        const previous = liveTrackEvidenceRef.current.get(key);
        liveTrackEvidenceRef.current.set(key, {
          hits: previous && observedAt - previous.lastSeen <= 2_500 ? previous.hits + 1 : 1,
          lastSeen: observedAt,
        });
      }
      for (const [key, evidence] of liveTrackEvidenceRef.current) {
        if (observedAt - evidence.lastSeen > 5_000) liveTrackEvidenceRef.current.delete(key);
      }
      // One-frame YOLO guesses are common around headlights and lane paint.
      // Two consecutive observations are required before the UI calls it a
      // vehicle, counts it, or stores its snapshot.
      const confirmedRawNext = rawNext.filter((vehicle) =>
        (liveTrackEvidenceRef.current.get(`${camera.id}:${vehicle.id}`)?.hits ?? 0) >= 2);

      const existing = cameraSessionsRef.current[camera.id] ?? { vehicles: [], total: 0 };
      const claimedExistingIds = new Set<string>();
      const next = confirmedRawNext.map((vehicle) => {
        const exact = existing.vehicles.find((saved) => saved.id === vehicle.id);
        if (exact) {
          claimedExistingIds.add(exact.id);
          return mergeVehicleEvidence(exact, vehicle);
        }
        const recoveredTrack = existing.vehicles.find((saved) =>
          !claimedExistingIds.has(saved.id) && likelySameVehicle(saved, vehicle));
        if (!recoveredTrack) return vehicle;
        claimedExistingIds.add(recoveredTrack.id);
        return mergeVehicleEvidence(recoveredTrack, vehicle);
      });
      const previousLive = liveDetectionsByCameraRef.current[camera.id] ?? [];
      liveDetectionsByCameraRef.current[camera.id] = next;
      const currentViewChanged = previousLive.length !== next.length ||
        previousLive.some((vehicle, index) => vehicle.id !== next[index]?.id);
      const known = new Set(existing.vehicles.map((vehicle) => vehicle.id));
      const additions = next.filter((vehicle) => !known.has(vehicle.id));
      const plateChanged = next.some((vehicle) => {
        const saved = existing.vehicles.find((item) => item.id === vehicle.id);
        return Boolean(vehicle.plate_number && vehicle.plate_number !== saved?.plate_number);
      });
      // Track recovery above already removes genuine duplicates using plate or
      // geometry. Do not collapse every same-type vehicle arriving within 15s;
      // two cars following each other are still two vehicles.
      const displayAdditions = additions;
      const currentById = new Map(next.map((vehicle) => [vehicle.id, vehicle]));
      const updatedVehicles = [
        ...displayAdditions,
        ...existing.vehicles.map((vehicle) => currentById.get(vehicle.id) ?? vehicle),
      ].slice(0, 50);
      if (additions.length > 0) {
        for (const vehicle of additions) {
          countedVehiclesRef.current.add(`${camera.id}:${vehicle.id}`);
          recordCountedVehicle(vehicle, camera.id, true);
        }
      }
      const updated = {
        vehicles: updatedVehicles,
        total: existing.total + additions.length,
      };
      cameraSessionsRef.current[camera.id] = updated;
      if (additions.length > 0 || plateChanged || currentViewChanged) {
        setCameraWallRevision((revision) => revision + 1);
      }

      if (selectedCameraIdRef.current === camera.id) {
        // Shared Vision is authoritative for shared cameras. Using the local
        // HTTP scanner here as well counted the same vehicle through two paths.
        setActiveDetections(next);
        setSelectedVehicleIndex(0);
        setSessionVehicles(updated.vehicles);
        setTotalVehiclesCaptured(updated.total);
      }

      // Shared-camera ANPR is already persisted by the vision service's
      // durable plate_read event. Posting it again here created duplicate logs.
    }));
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [cameras, playWatchlistSiren, recordCountedVehicle]);

  // The browser scanner uses a local Python service. Never call it "online"
  // just because the page loaded: check the real model endpoint and show a
  // useful recovery message when it is not running.
  useEffect(() => {
    let mounted = true;
    const checkModel = async () => {
      try {
        const response = await fetch("http://127.0.0.1:8001/health");
        if (!response.ok) throw new Error("health check failed");
        const health = await response.json() as { llm_fallback?: boolean; llm_model?: string | null };
        if (mounted) {
          setModelOnline(true);
          setModelMessage(health.llm_fallback
            ? `Local YOLO + OCR online · AI fallback ready (${health.llm_model ?? "vision model"})`
            : "Local YOLO + OCR online · AI fallback not configured");
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

  // Backend acknowledgement rows are intentionally not copied back into the
  // scanner session. The tracked vehicle is already present here; hydrating
  // the acknowledgement used to count it twice and could replace a real crop
  // with the backend's legacy `snapshot_car` placeholder.

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
          : "Camera feed inactive. Retry the camera or select a shared camera.",
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

  /** Analyze the complete current frame with the local YOLO + OCR service. */
  const captureAndDetectCar = useCallback(async (videoElement: HTMLVideoElement | null, sourceName: string) => {
    if (!videoElement || videoElement.readyState < 2 || analysisInFlightRef.current) return;
    const canvas = offscreenCanvasRef.current;
    if (!canvas || !videoElement.videoWidth) return;

    analysisInFlightRef.current = true;
    try {
      // Keep registration characters readable in saved evidence and in the
      // enlarged preview. YOLO resizes internally, so this only preserves the
      // source pixels supplied to OCR/Gemini and the snapshot crop.
      const scale = Math.min(1, 1280 / videoElement.videoWidth);
      canvas.width = Math.round(videoElement.videoWidth * scale);
      canvas.height = Math.round(videoElement.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const response = await fetch("http://localhost:8001/detect", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image: canvas.toDataURL("image/jpeg", 0.94),
          source_id: sourceMode === "camera" ? selectedCameraId : "local-live-camera",
        }),
      });
      if (!response.ok) throw new Error("ANPR service unavailable");
      const result = await response.json() as { detections: Array<{ track_id?: number | null; track_key?: string; vehicle_type: string; confidence: number; bbox: [number, number, number, number]; plate?: { text: string; confidence: number; bbox: [number, number, number, number]; source?: "ocr" | "llm"; verified?: boolean; model?: string | null } }> };
      const at = new Date().toISOString();
      const snapshotFor = (bbox: [number, number, number, number]) => {
        const x1 = Math.max(0, Math.floor(bbox[0] * canvas.width));
        const y1 = Math.max(0, Math.floor(bbox[1] * canvas.height));
        const x2 = Math.min(canvas.width, Math.ceil(bbox[2] * canvas.width));
        const y2 = Math.min(canvas.height, Math.ceil(bbox[3] * canvas.height));
        if (x2 <= x1 || y2 <= y1) return null;
        const sourceWidth = x2 - x1;
        const sourceHeight = y2 - y1;
        const crop = document.createElement("canvas");
        const enlargement = sourceWidth < 320 ? Math.min(3, 960 / sourceWidth) : 1;
        crop.width = Math.max(1, Math.round(sourceWidth * enlargement));
        crop.height = Math.max(1, Math.round(sourceHeight * enlargement));
        const context = crop.getContext("2d");
        if (!context) return null;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(canvas, x1, y1, sourceWidth, sourceHeight, 0, 0, crop.width, crop.height);
        return crop.toDataURL("image/jpeg", 0.95);
      };
      const detections: PlateDetection[] = result.detections
        .filter((item) => item.confidence >= 0.45)
        .map((item, index) => {
        const plate = item.plate?.text ?? "";
        const normalized = plate.replace(/[^A-Z0-9]/gi, "").toUpperCase();
        const verified = item.plate?.verified !== false;
        const matchedEntry = normalized && verified
          ? watchlistCacheRef.current.find((entry) => entry.active && entry.plate_number.replace(/[^A-Z0-9]/gi, "").toUpperCase() === normalized) ?? null
          : null;
        return {
          id: `${sourceMode === "camera" ? selectedCameraId : "local-live"}:live-track-${item.track_key ?? item.track_id ?? index}`,
          org_id: "org_bsf",
          camera_id: sourceMode === "camera" ? selectedCameraId : "cam_fence_north",
          camera_name: sourceName,
          zone_id: null, plate_number: plate, vehicle_type: item.vehicle_type,
          confidence: item.confidence, plate_confidence: item.plate?.confidence ?? 0,
          plate_source: item.plate?.source ?? "ocr",
          plate_verified: verified,
          matched_watchlist_id: matchedEntry?.id ?? null,
          matched_entry: matchedEntry,
          match_status: matchedEntry ? ("MATCHED" as const) : ("UNVERIFIED" as const),
          severity: matchedEntry?.severity ?? "INFO",
          bbox: item.bbox, plate_bbox: item.plate?.bbox ?? [0, 0, 0, 0],
        // Captured Vehicles represents the vehicle. Keep the full vehicle crop
        // here; the plate number and plate bbox remain available separately.
        image_snapshot: snapshotFor(item.bbox), simulated: false, occurred_at: at, created_at: at,
        };
      }).map((vehicle) => {
        const previous = visibleVehiclesRef.current.get(vehicle.id)?.vehicle;
        return previous ? mergeVehicleEvidence(previous, vehicle) : vehicle;
      });
      const newMatches = detections.filter((vehicle) =>
        vehicle.match_status === "MATCHED" && !alarmedVehiclesRef.current.has(vehicle.id));
      if (newMatches.length > 0) {
        newMatches.forEach((vehicle) => alarmedVehiclesRef.current.add(vehicle.id));
        playWatchlistSiren();
      }
      setActiveDetections(detections);
      setSelectedVehicleIndex(0);
      const now = Date.now();
      const current = new Map(detections.map((vehicle) => [vehicle.id, vehicle]));
      for (const vehicle of detections) {
        const previous = visibleVehiclesRef.current.get(vehicle.id);
        visibleVehiclesRef.current.set(vehicle.id, {
          vehicle,
          firstSeen: previous?.firstSeen ?? now,
          lastSeen: now,
          hits: (previous?.hits ?? 0) + 1,
        });
      }
      setSessionVehicles((previous) => {
        if (sourceMode !== "camera") {
          return previous.map((saved) => current.get(saved.id) ?? saved);
        }
        const enriched = [...previous];
        for (const detection of detections) {
          const exactIndex = enriched.findIndex((saved) => saved.id === detection.id);
          if (exactIndex >= 0) {
            enriched[exactIndex] = detection;
            continue;
          }
          const likelyTrackIndex = enriched.findIndex((saved) =>
            likelySameVehicle(saved, detection));
          if (likelyTrackIndex >= 0) {
            enriched[likelyTrackIndex] = { ...detection, id: enriched[likelyTrackIndex]!.id };
          }
        }
        return enriched.slice(0, 50);
      });
      const candidates = [...visibleVehiclesRef.current.entries()]
        .filter(([key, state]) =>
          countOnFirstDetection ||
          // A stable vehicle contributes to the completed total only after it
          // has crossed out of the view. The short delay tolerates one missed
          // detector frame without declaring a false exit.
          (state.hits >= 2 && !current.has(key) && now - state.lastSeen >= 1_250))
        .map(([key, state]) => ({ key, vehicle: state.vehicle }));
      // The selected camera is counted from this high-quality path. Other
      // cameras continue through the shared background tracker, so a vehicle
      // is never counted by both pipelines at the same time.
      const countKeyFor = (key: string) => sourceMode === "camera"
        ? `${selectedCameraId || "cam_fence_north"}:${key}`
        : `local-live:${key}`;
      const newlyCounted = candidates.filter(({ key }) =>
        !countedVehiclesRef.current.has(countKeyFor(key)));
      if (newlyCounted.length) {
        newlyCounted.forEach(({ key, vehicle }) => {
          countedVehiclesRef.current.add(countKeyFor(key));
          recordCountedVehicle(vehicle, selectedCameraId || "cam_fence_north", sourceMode === "camera");
          visibleVehiclesRef.current.delete(key);
        });
        setTotalVehiclesCaptured((count) => count + newlyCounted.length);
        setSessionVehicles((previous) => {
          const existingIds = new Set(previous.map((vehicle) => vehicle.id));
          const additions = newlyCounted
            .map(({ vehicle }) => vehicle)
            .filter((vehicle) => !existingIds.has(vehicle.id));
          return [...additions, ...previous].slice(0, 100);
        });
      }
      // Keep visible state after counting so the same stable track cannot be
      // inserted again while it approaches the camera.
      for (const item of detections.filter((candidate) => candidate.plate_number && candidate.plate_verified !== false)) {
        const submissionKey = `${item.id}:${item.plate_number}`;
        if (!submittedPlatesRef.current.has(submissionKey)) {
          submittedPlatesRef.current.set(submissionKey, Date.now());
          onManualScan({
            ...item,
            camera_id: sourceMode === "camera" ? selectedCameraId : "cam_fence_north",
          });
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
  }, [countOnFirstDetection, onManualScan, playWatchlistSiren, recordCountedVehicle, selectedCameraId, sourceMode]);

  // Continuous Video Scan Interval Loop
  useEffect(() => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
    }

    if (modelOnline && sourceMode === "live" && isLiveStreaming && continuousScan) {
      scanIntervalRef.current = setInterval(() => {
        void captureAndDetectCar(liveVideoRef.current, "Live Camera Feed");
      }, 750);
    }

    return () => {
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
      }
    };
  }, [sourceMode, isLiveStreaming, continuousScan, modelOnline, captureAndDetectCar]);

  const contextualSessionVehicles = cameraWallOpen
    ? cameras
        .flatMap((camera) => cameraSessionsRef.current[camera.id]?.vehicles ?? [])
        .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
    : sessionVehicles;
  const contextualActiveDetections = cameraWallOpen
    ? cameras.flatMap((camera) => liveDetectionsByCameraRef.current[camera.id] ?? [])
    : activeDetections;
  const contextualTotalVehicles = todayVehicleTotal ?? (cameraWallOpen
    ? cameras.reduce((total, camera) => total + (cameraSessionsRef.current[camera.id]?.total ?? 0), 0)
    : totalVehiclesCaptured);

  // Wall mode summarises every camera. Focused mode uses only the selected one.
  const primaryDetection = cameraWallOpen
    ? contextualActiveDetections.find((vehicle) => vehicle.match_status === "MATCHED") ??
      contextualActiveDetections.find((vehicle) => vehicle.plate_number) ?? contextualActiveDetections[0] ?? null
    : activeDetections.find((vehicle) => vehicle.match_status === "MATCHED") ??
      activeDetections[selectedVehicleIndex] ?? activeDetections[0] ?? null;
  const scopedTodayDetections = todayDetections.filter((vehicle) =>
    vehicle.simulated === false && withinCaptureRetention(vehicle) &&
    (cameraWallOpen || vehicle.camera_id === selectedCameraId));
  // Durable OCR rows are the current-date source of truth. Add today's
  // in-memory unplated tracks so the rail can still show a captured vehicle
  // before OCR succeeds, while collapsing its later durable acknowledgement.
  const capturedVehicles = [...scopedTodayDetections, ...contextualSessionVehicles]
    .filter((vehicle) => vehicle.simulated === false && withinCaptureRetention(vehicle))
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
    .reduce<PlateDetection[]>((unique, vehicle) => {
      const plate = normalizedPlate(vehicle.plate_number);
      const duplicateIndex = unique.findIndex((saved) =>
        saved.camera_id === vehicle.camera_id && (
          saved.id === vehicle.id ||
          (Boolean(saved.image_snapshot) &&
            saved.image_snapshot === vehicle.image_snapshot) ||
          (plate && normalizedPlate(saved.plate_number) === plate &&
            Math.abs(Date.parse(saved.occurred_at) - Date.parse(vehicle.occurred_at)) <= 15_000) ||
          // Collapse previously persisted fragments of the same unplated
          // track as well; old ByteTrack IDs must not remain as 2–3 rows after
          // the camera-level stitcher has recovered one physical vehicle.
          (!plate && !normalizedPlate(saved.plate_number) &&
            likelySameVehicle(saved, vehicle))
        ));
      if (duplicateIndex < 0) unique.push(vehicle);
      else unique[duplicateIndex] = mergeVehicleEvidence(unique[duplicateIndex]!, vehicle);
      return unique;
    }, []);
  const inspectionDetection =
    primaryDetection;
  const isMatched = inspectionDetection?.match_status === "MATCHED";
  const inspectionPlateNumber = inspectionDetection?.plate_number || "No plate read";
  const hasReadableInspectionPlate = Boolean(inspectionDetection?.plate_number?.trim());
  const inspectionJurisdiction = plateJurisdiction(inspectionDetection?.plate_number);

  const inViewCount = contextualActiveDetections.length;
  const countByType = Object.keys(todayVehicleTypes).length > 0
    ? todayVehicleTypes
    : capturedVehicles.reduce<Record<string, number>>((counts, vehicle) => {
        const type = (vehicle.vehicle_type || "vehicle").toUpperCase();
        counts[type] = (counts[type] ?? 0) + 1;
        return counts;
      }, {});
  const vehicleTypeEntries = Object.entries(countByType).sort(([, countA], [, countB]) => countB - countA);
  const vehicleTypeTotal = vehicleTypeEntries.reduce((sum, [, count]) => sum + count, 0);
  const readablePlateCount = capturedVehicles.filter((vehicle) =>
    Boolean(vehicle.plate_number?.trim()) && vehicle.plate_verified !== false).length;
  const watchlistHitCount = capturedVehicles.filter((vehicle) => vehicle.match_status === "MATCHED").length;
  const dominantType = vehicleTypeEntries[0] ?? null;
  const dominantPercentage = dominantType && vehicleTypeTotal > 0
    ? Math.round((dominantType[1] / vehicleTypeTotal) * 100)
    : 0;
  const latestSessionCapture = capturedVehicles.reduce<PlateDetection | null>((latest, vehicle) =>
    !latest || Date.parse(vehicle.occurred_at) > Date.parse(latest.occurred_at) ? vehicle : latest, null);
  const distributionScope = cameraWallOpen ? "All cameras" : selectedCamera?.name ?? "Selected camera";
  const readyCameraCount = cameras.filter((camera) => camera.ready).length;
  const distributionLiveState = cameraWallOpen
    ? `${readyCameraCount}/${cameras.length} cameras live`
    : selectedCamera?.ready ? "Camera live" : "Camera offline";
  const distributionColors = ["#2563eb", "#3b82f6", "#60a5fa", "#93c5fd", "#64748b", "#14b8a6"];
  let distributionCursor = 0;
  const distributionSegments = vehicleTypeEntries.map(([, count], index) => {
    const start = vehicleTypeTotal > 0 ? (distributionCursor / vehicleTypeTotal) * 100 : 0;
    distributionCursor += count;
    const end = vehicleTypeTotal > 0 ? (distributionCursor / vehicleTypeTotal) * 100 : 100;
    return `${distributionColors[index % distributionColors.length]} ${start}% ${end}%`;
  });
  const distributionBackground = vehicleTypeTotal > 0
    ? `conic-gradient(${distributionSegments.join(", ")})`
    : "conic-gradient(#e2e8f0 0% 100%)";

  return (
    <div className="grid min-w-0 grid-cols-1 items-stretch gap-4 overflow-x-hidden xl:grid-cols-[minmax(0,1fr)_minmax(22rem,32%)] xl:grid-rows-[auto_22rem]">
      <canvas ref={offscreenCanvasRef} className="hidden" />

      {/* Main Video Viewport & Detection Overlay */}
      <div className="grid min-w-0 gap-4 xl:row-span-2 xl:grid-rows-subgrid">
        <Card className="relative min-h-0 min-w-0 gap-0 overflow-hidden border bg-slate-950 py-0 text-slate-100 shadow-sm">
          {/* Viewport Frame */}
          <div ref={sharedCameraViewportRef} className="relative flex h-full min-h-[19rem] w-full items-center justify-center overflow-hidden bg-slate-950 select-none sm:min-h-[24rem]">
            {sourceMode === "camera" && cameraWallOpen && (
              <div className="absolute inset-0 z-30 flex flex-col bg-slate-100 p-2 text-slate-950 dark:bg-slate-950 dark:text-slate-100">
                <div className="mb-2 flex items-center justify-between px-1">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <Grid3X3Icon className="h-4 w-4 text-blue-600" />
                      Live camera screens
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">Select a screen to open the full ANPR workspace</div>
                  </div>
                  {cameraWallPages > 1 && (
                    <div className="rounded-full border bg-background px-2.5 py-1 text-[10px] font-semibold tabular-nums">
                      {cameraWallPage + 1} / {cameraWallPages}
                    </div>
                  )}
                </div>

                <div className="relative min-h-0 flex-1">
                  <div className="grid h-full auto-rows-[13rem] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3 lg:grid-rows-2 lg:auto-rows-auto lg:overflow-visible lg:pr-0">
                    {wallCameras.map((camera) => {
                      const cameraSession = cameraSessionsRef.current[camera.id] ?? { vehicles: [], total: 0 };
                      const cameraTotal = cameraSession.total;
                      const latestVehicle = cameraSession.vehicles.find((vehicle) => vehicle.plate_number) ?? cameraSession.vehicles[0] ?? null;
                      const watchlistHit = (liveDetectionsByCameraRef.current[camera.id] ?? [])
                        .find((vehicle) => vehicle.match_status === "MATCHED") ??
                        cameraSession.vehicles.find((vehicle) =>
                          vehicle.match_status === "MATCHED" && Date.now() - Date.parse(vehicle.occurred_at) < 60_000) ?? null;
                      const displayVehicle = watchlistHit ?? latestVehicle;
                      return (
                        <button
                          key={camera.id}
                          type="button"
                          onClick={() => {
                            if (watchlistHit) {
                              cameraSessionsRef.current[camera.id] = {
                                ...cameraSession,
                                vehicles: [watchlistHit, ...cameraSession.vehicles.filter((vehicle) => vehicle.id !== watchlistHit.id)],
                              };
                              setActiveDetections([watchlistHit]);
                              setSelectedVehicleIndex(0);
                            }
                            setSelectedCameraId(camera.id);
                            setCameraWallOpen(false);
                          }}
                          className={`group flex min-h-0 flex-col overflow-hidden rounded-lg border text-left transition focus-visible:outline-none focus-visible:ring-2 ${
                            watchlistHit
                              ? "border-red-500 bg-red-50 shadow-lg shadow-red-500/20 ring-2 ring-red-500/60 focus-visible:ring-red-500 dark:bg-red-950/30"
                              : "bg-background shadow-sm hover:border-blue-500 hover:shadow-md focus-visible:ring-blue-500"
                          }`}
                        >
                          <div className={`flex w-full items-center gap-2 px-2.5 py-1.5 ${watchlistHit ? "bg-red-600 text-white" : ""}`}>
                            <CameraIcon className={`h-3.5 w-3.5 ${watchlistHit ? "text-white" : "text-slate-600 dark:text-slate-300"}`} />
                            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{camera.name}</span>
                            {watchlistHit ? (
                              <span className="flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wide">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> Watchlist hit
                              </span>
                            ) : (
                              <>
                                <span className={`h-2 w-2 rounded-full ${camera.ready ? "bg-emerald-500" : "bg-red-500"}`} />
                                <span className="text-[9px] font-medium text-muted-foreground">{camera.ready ? "Live" : "Offline"}</span>
                              </>
                            )}
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold tabular-nums">{cameraTotal} vehicles</span>
                          </div>
                          <div className="relative min-h-0 w-full flex-1 overflow-hidden bg-slate-950">
                            <CameraFeed
                              cameraId={camera.id}
                              whepBase={media?.whepBase}
                              module="anpr"
                              showBoxes={false}
                              fit="cover"
                              className="absolute inset-0 h-full w-full border-0"
                            />
                            {watchlistHit && (
                              <div className="pointer-events-none absolute inset-0 border-[3px] border-red-500 shadow-[inset_0_0_32px_rgba(239,68,68,0.38)]" />
                            )}
                            <div className={`pointer-events-none absolute inset-x-0 bottom-0 px-2 py-1.5 pt-6 text-white ${watchlistHit ? "bg-gradient-to-t from-red-950 via-red-900/80 to-transparent" : "bg-gradient-to-t from-black/90 via-black/65 to-transparent"}`}>
                              <div className="mb-0.5 flex items-center justify-between gap-2 text-[10px] font-semibold">
                                <span className={watchlistHit ? "text-red-100" : displayVehicle?.plate_number ? "text-emerald-300" : "text-slate-300"}>
                                  {displayVehicle?.plate_number
                                    ? `${camera.ready ? "Plate" : "Last plate"} ${displayVehicle.plate_number}`
                                    : camera.ready ? "Scanning for plate…" : "Camera offline"}
                                </span>
                                <span className="uppercase text-slate-200">{displayVehicle?.vehicle_type ?? "No vehicle"}</span>
                              </div>
                              <div className="flex items-center justify-between font-mono text-[9px] text-slate-200">
                                <span>{feedClock.toLocaleDateString("en-CA")} {feedClock.toLocaleTimeString("en-GB", { hour12: false })}</span>
                                <span>{camera.id}</span>
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {cameraWallPages > 1 && (
                    <>
                      <button
                        type="button"
                        aria-label="Previous camera screens"
                        disabled={cameraWallPage === 0}
                        onClick={() => setCameraWallPage((page) => Math.max(0, page - 1))}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-slate-950/80 p-2 text-white shadow-lg backdrop-blur transition hover:bg-slate-950 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <ChevronLeftIcon className="h-5 w-5" />
                      </button>
                      <button
                        type="button"
                        aria-label="Next camera screens"
                        disabled={cameraWallPage >= cameraWallPages - 1}
                        onClick={() => setCameraWallPage((page) => Math.min(cameraWallPages - 1, page + 1))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-slate-950/80 p-2 text-white shadow-lg backdrop-blur transition hover:bg-slate-950 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <ChevronRightIcon className="h-5 w-5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Shared Media Server camera */}
            {sourceMode === "camera" && !cameraWallOpen && selectedCameraId && (
              <CameraFeed
                cameraId={selectedCameraId}
                whepBase={media?.whepBase}
                module="anpr"
                showBoxes={false}
                fit="cover"
                className="absolute inset-0 h-full w-full border-0"
              />
            )}

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
                </div>
              </div>
            )}

            {/* Camera identity — kept readable against bright and dark footage. */}
            {!cameraWallOpen && <div className="pointer-events-none absolute left-3 top-3 z-20 max-w-[55%] rounded-lg bg-slate-950/58 px-2.5 py-2 text-white shadow-lg backdrop-blur-[2px] sm:max-w-none sm:px-3">
              <div className="flex min-w-0 items-center gap-2 text-xs font-semibold sm:text-sm">
                <CameraIcon className="h-4 w-4" />
                <span className="truncate">{selectedCamera?.name ?? selectedCameraId ?? "Camera"} — Live</span>
              </div>
              <div className="mt-0.5 hidden text-[11px] text-slate-200 sm:block">
                Attari · Live monitoring&nbsp; | &nbsp;{selectedCameraId || "Camera —"}
              </div>
            </div>}

            {/* Live state and clock. A real watchlist hit replaces only the state badge. */}
            {!cameraWallOpen && <div className="pointer-events-none absolute right-3 top-3 z-20 flex items-start gap-2 rounded-lg bg-slate-950/58 px-2.5 py-2 text-white shadow-lg backdrop-blur-[2px] sm:gap-3 sm:px-3">
              {isMatched ? (
                <div className="flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1 text-[10px] font-bold">
                  <ShieldAlertIcon className="h-3.5 w-3.5" /> WATCHLIST HIT
                </div>
              ) : selectedCamera?.ready ? (
                <div className="flex items-center gap-1.5 rounded-full bg-emerald-700 px-3 py-1 text-[10px] font-bold">
                  <span className="h-2 w-2 rounded-full bg-emerald-300" /> LIVE
                </div>
              ) : (
                <div className="flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1 text-[10px] font-bold">
                  <span className="h-2 w-2 rounded-full bg-red-200" /> OFFLINE
                </div>
              )}
              <div className="text-right font-mono leading-tight">
                <div className="text-sm font-bold tabular-nums">
                  {feedClock.toLocaleTimeString("en-GB", { hour12: false })}
                </div>
                <div className="mt-1 hidden text-[10px] text-slate-200 sm:block">
                  {feedClock.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}
                </div>
              </div>
            </div>}

            {!cameraWallOpen && <div className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-lg border border-white/15 bg-slate-950/75 px-3 py-2 text-white shadow-lg backdrop-blur-sm">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <span className={`h-2.5 w-2.5 rounded-full ${selectedCamera?.ready ? "animate-pulse bg-emerald-400" : "bg-amber-400"}`} />
                {!selectedCamera?.ready
                  ? "Detection paused · camera offline"
                  : inViewCount > 0
                    ? `Tracking ${inViewCount} vehicle${inViewCount === 1 ? "" : "s"}…`
                    : "Scanning for vehicles…"}
              </div>
            </div>}

            {!cameraWallOpen && <div className="absolute bottom-3 right-3 z-20 flex items-center gap-2">
              <div className="pointer-events-none hidden rounded-lg bg-slate-950/70 px-3 py-2 text-[10px] text-slate-200 shadow backdrop-blur-sm sm:block">
                {selectedCamera?.name ?? selectedCameraId ?? "Selected camera"} · {selectedCamera?.ready ? "Live feed" : "Offline"}
              </div>
              <button
                type="button"
                aria-label="Open camera fullscreen"
                title="Open fullscreen"
                onClick={() => void sharedCameraViewportRef.current?.requestFullscreen?.()}
                className="rounded-lg bg-slate-950/75 p-2.5 text-white shadow transition-colors hover:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                <Maximize2Icon className="h-4 w-4" />
              </button>
            </div>}

            {!cameraWallOpen && sourceMode === "camera" && (
              <button
                type="button"
                onClick={() => setCameraWallOpen(true)}
                className="absolute left-1/2 top-16 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/15 bg-slate-950/75 px-3 py-1.5 text-[10px] font-semibold text-white shadow backdrop-blur transition hover:bg-slate-900 sm:top-3"
              >
                <Grid3X3Icon className="h-3.5 w-3.5" />
                All cameras
              </button>
            )}
          </div>

        </Card>

        {/* --------------------------------- ZOOMED PLATE & CAR SNAPSHOT INSPECTOR --------------------------------- */}
        <Card className="gap-0 overflow-hidden border py-0 shadow-sm xl:h-[22rem]">
          <CardHeader className="py-3 px-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <CrosshairIcon className="h-4 w-4 text-primary" />
                <CardTitle className="text-sm font-semibold leading-5">
                  Plate Snapshot & Optical License Plate OCR Breakdown
                </CardTitle>
              </div>
              <Badge variant="secondary" className="font-mono text-xs">
                {cameraWallOpen ? "Unified ANPR" : "Real-Time ANPR"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col justify-center space-y-4 overflow-y-auto px-4 pb-4 pt-2">
            <div className="grid grid-cols-1 gap-2 border-b pb-3 sm:grid-cols-3">
              <div className="rounded-lg bg-muted/30 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Total vehicles</div>
                <div className="mt-0.5 font-mono text-xl font-bold tabular-nums text-foreground">{contextualTotalVehicles}</div>
              </div>
              <div className="rounded-lg bg-muted/30 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">In current view</div>
                <div className="mt-0.5 font-mono text-xl font-bold tabular-nums text-emerald-600">{inViewCount}</div>
              </div>
              <div className="rounded-lg bg-muted/30 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Vehicle types</div>
                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] font-semibold text-foreground">
                  {Object.keys(countByType).length > 0
                    ? Object.entries(countByType).map(([type, count]) => (
                        <span key={type}>{type} <strong className="font-mono">{count}</strong></span>
                      ))
                    : <span className="font-normal text-muted-foreground">No vehicles yet</span>}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-12 items-center">
              {/* Captured Car Photo Snapshot Thumbnail */}
              <div className="sm:col-span-4 flex flex-col items-center justify-center p-2 rounded-md border bg-slate-950/80 text-slate-100 overflow-hidden">
                <div className="text-[10px] font-mono text-muted-foreground mb-1 flex items-center justify-between w-full px-1">
                  <span>PLATE SNAPSHOT</span>
                  <span className="text-cyan-400">
                    {inspectionDetection?.vehicle_type?.toUpperCase() ?? "CAR"}
                  </span>
                </div>
                {isDisplayableSnapshot(inspectionDetection?.image_snapshot) ? (
                  <button
                    type="button"
                    onClick={() => setEnlargedSnapshot(inspectionDetection?.image_snapshot ?? null)}
                    className="w-full cursor-zoom-in"
                    title="Click to enlarge vehicle photo"
                  >
                    <img
                      src={inspectionDetection?.image_snapshot ?? ""}
                      alt="Captured number plate — click to enlarge"
                      className="h-32 w-full rounded border border-slate-700 bg-black object-contain transition-colors hover:border-cyan-400"
                    />
                  </button>
                ) : (
                  <div className="flex h-32 w-full flex-col items-center justify-center gap-1 rounded border border-slate-800 bg-slate-900 text-xs text-slate-500">
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
                  <span>{inspectionJurisdiction.code}</span>
                  <span>{inspectionJurisdiction.label}</span>
                  <span className={`h-2 w-2 rounded-full ${inspectionJurisdiction.verified ? "bg-blue-600" : "bg-amber-500"}`} />
                </div>
                <div className="max-w-full overflow-x-auto whitespace-nowrap px-2 py-1 text-2xl font-mono font-black tracking-widest text-slate-950">
                  {inspectionPlateNumber}
                </div>
                <div className="mt-1 flex w-full items-center justify-between border-t border-slate-300 px-2 pt-1 text-[10px] text-slate-600">
                  <span>{vehicleTypeLabel(inspectionDetection?.vehicle_type)}</span>
                  <strong className={inspectionDetection?.plate_verified === false ? "text-amber-700" : "text-emerald-700"}>
                    {inspectionDetection?.plate_verified === false
                      ? "Unverified"
                      : `${Math.round((inspectionDetection?.plate_confidence ?? 0) * 100)}% confidence`}
                  </strong>
                </div>
              </div>

                {/* OCR returns confidence for the full read, not per character. */}
              <div className="sm:col-span-4 space-y-2">
                <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
                  <span>{inspectionDetection?.plate_verified === false ? "AI estimate:" : "OCR Confidence:"}</span>
                  <span className={`font-mono font-semibold ${inspectionDetection?.plate_verified === false ? "text-amber-600" : "text-emerald-600"}`}>
                    {!hasReadableInspectionPlate
                      ? "0%"
                      : inspectionDetection?.plate_verified === false
                        ? "UNVERIFIED"
                        : `${Math.round((inspectionDetection?.plate_confidence ?? 0) * 100)}%`}
                  </span>
                </div>
                <div className="flex w-full flex-nowrap gap-1 overflow-hidden">
                  {hasReadableInspectionPlate ? (
                    inspectionPlateNumber.replace(/\s+/g, "").split("").map((char, index) => (
                      <div
                        key={index}
                        className="flex h-8 min-w-0 flex-1 items-center justify-center rounded border bg-muted/40 px-0.5 text-center"
                      >
                        <span className="font-mono font-bold text-xs text-foreground">{char}</span>
                      </div>
                    ))
                  ) : (
                    <span className="text-[11px] text-muted-foreground">Waiting for a readable number plate…</span>
                  )}
                </div>
                <dl className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 border-t pt-2 text-[10px]">
                  <dt className="text-muted-foreground">Timestamp</dt>
                  <dd className="truncate font-medium text-foreground">
                    {inspectionDetection?.occurred_at
                      ? new Date(inspectionDetection.occurred_at).toLocaleString("en-IN", { hour12: false })
                      : "Waiting for detection"}
                  </dd>
                  <dt className="text-muted-foreground">Camera</dt>
                  <dd className="truncate font-medium text-foreground">
                    {inspectionDetection?.camera_name ?? inspectionDetection?.camera_id ?? selectedCamera?.name ?? "—"}
                  </dd>
                  <dt className="text-muted-foreground">Vehicle</dt>
                  <dd className="truncate font-medium text-foreground">
                    {vehicleTypeLabel(inspectionDetection?.vehicle_type)}
                  </dd>
                  <dt className="text-muted-foreground">Reading</dt>
                  <dd className={`truncate font-medium ${inspectionDetection?.plate_verified === false ? "text-amber-600" : "text-emerald-600"}`}>
                    {inspectionDetection?.plate_verified === false
                      ? "AI estimate · unverified"
                      : hasReadableInspectionPlate
                        ? "OCR verified"
                        : "Awaiting readable plate"}
                  </dd>
                </dl>
              </div>
            </div>

            {/* BOLO Alert Warning Box if matched */}
            {isMatched && inspectionDetection?.matched_entry && (
              <div className="overflow-hidden rounded-lg border border-red-500/50 bg-red-500/[0.07] text-red-950 dark:text-red-100">
                <div className="flex items-center justify-between gap-3 bg-red-600 px-3.5 py-2 text-white">
                  <div className="flex min-w-0 items-center gap-2">
                    <ShieldAlertIcon className="h-4 w-4 shrink-0" />
                    <strong className="truncate text-xs font-bold uppercase tracking-wide">
                      Suspicious vehicle · {inspectionDetection.matched_entry.plate_number}
                    </strong>
                  </div>
                  <SeverityBadge severity={inspectionDetection.severity} />
                </div>
                <div className="grid gap-x-5 gap-y-2 px-3.5 py-3 text-[11px] sm:grid-cols-2">
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Watchlist reason</div>
                    <div className="mt-0.5 font-semibold text-red-700 dark:text-red-300">{inspectionDetection.matched_entry.flag_reason}</div>
                  </div>
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Detected at</div>
                    <div className="mt-0.5 font-medium">
                      {inspectionDetection.camera_name ?? inspectionDetection.camera_id} · {new Date(inspectionDetection.occurred_at).toLocaleString("en-IN", { hour12: false })}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Vehicle details</div>
                    <div className="mt-0.5 font-medium">
                      {[inspectionDetection.matched_entry.color, inspectionDetection.matched_entry.make_model, inspectionDetection.matched_entry.vehicle_type]
                        .filter(Boolean).join(" · ") || inspectionDetection.vehicle_type}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">ANPR verification</div>
                    <div className="mt-0.5 font-medium">
                      {Math.round(inspectionDetection.plate_confidence * 100)}% confidence · {inspectionDetection.match_status}
                    </div>
                  </div>
                  {inspectionDetection.matched_entry.notes && (
                    <div className="rounded-md border border-red-200/70 bg-red-50/80 px-2.5 py-2 font-mono text-[10px] text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200 sm:col-span-2">
                      <strong>Supervisor note:</strong> {inspectionDetection.matched_entry.notes}
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Control Sidebar with 4 Feed Modes & Session Vehicle List */}
      <div className="grid min-w-0 gap-4 xl:row-span-2 xl:grid-rows-subgrid">
        <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden">
        <Card className="gap-0 overflow-hidden border py-0 shadow-sm">
          <CardHeader className="px-4 pb-2.5 pt-3.5">
            <CardTitle className="text-[15px] font-semibold tracking-tight">
              Feed Source & ANPR Controls
            </CardTitle>
            <CardDescription className="mt-1 text-[11px] leading-4">
              Select the shared camera used for live ANPR monitoring.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-1">
            <div className="space-y-1.5">
              <Label className="text-[11px] font-semibold">Select shared camera</Label>
              <Select value={selectedCameraId} onValueChange={(cameraId) => {
                setSelectedCameraId(cameraId);
                setCameraWallOpen(false);
              }}>
                <SelectTrigger className="h-10 w-full rounded-lg text-[12px] font-medium focus:ring-1 focus:ring-primary/30"><SelectValue placeholder="Select camera" /></SelectTrigger>
                <SelectContent>
                  {cameras.map((camera) => (
                    <SelectItem key={camera.id} value={camera.id} className="text-xs">
                      {camera.name} {camera.ready ? "— Live" : "— Offline"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

          </CardContent>
        </Card>

        {/* --------------------------------- CAPTURED VEHICLES SNAPSHOT LOG --------------------------------- */}
        <Card className="h-[26rem] min-h-0 shrink-0 gap-0 overflow-hidden border py-0 shadow-sm">
          <CardHeader className="border-b px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold tracking-tight">
                <ListOrderedIcon className="h-3.5 w-3.5 text-primary" />
                {cameraWallOpen ? "All-camera Vehicles" : "Captured Vehicles"} ({capturedVehicles.length})
              </CardTitle>
              <div className="flex items-center gap-2">
                <span className="hidden items-center gap-1 text-[10px] text-emerald-600 sm:flex">
                  <span className={`h-1.5 w-1.5 rounded-full ${cameraWallOpen ? (cameras.some((camera) => camera.ready) ? "bg-emerald-500" : "bg-red-500") : (selectedCamera?.ready ? "bg-emerald-500" : "bg-red-500")}`} />
                  {cameraWallOpen
                    ? cameras.some((camera) => camera.ready) ? "Live stream" : "Offline · retained history"
                    : selectedCamera?.ready ? "Live stream" : "Offline · retained history"}
                </span>
                {capturedVehicles.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px]"
                    onClick={() => {
                      if (cameraWallOpen) {
                        for (const camera of cameras) {
                          cameraSessionsRef.current[camera.id] = { vehicles: [], total: 0 };
                        }
                        setCameraWallRevision((revision) => revision + 1);
                      } else if (selectedCameraId) {
                        cameraSessionsRef.current[selectedCameraId] = { vehicles: [], total: 0 };
                      }
                      setSessionVehicles([]);
                      setTotalVehiclesCaptured(0);
                      trafficSessionRef.current = `anpr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                      visibleVehiclesRef.current.clear();
                      countedVehiclesRef.current.clear();
                      submittedPlatesRef.current.clear();
                      alarmedVehiclesRef.current.clear();
                    }}
                  >
                    Clear All
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <div className="grid grid-cols-[3rem_minmax(4.5rem,1fr)_3.5rem] items-center gap-1.5 bg-muted/20 px-2.5 py-2 text-[8px] font-semibold uppercase tracking-[0.03em] text-muted-foreground sm:grid-cols-[3rem_minmax(4.75rem,1.1fr)_minmax(4.25rem,0.9fr)_3rem_3.25rem]">
            <span>Time</span>
            <span>Plate</span>
            <span className="hidden sm:block">{cameraWallOpen ? "Camera / Vehicle" : "Vehicle"}</span>
            <span className="hidden sm:block">Preview</span>
            <span className="text-right">Status</span>
          </div>
          <CardContent className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-0 [scrollbar-gutter:stable]">
            {capturedVehicles.length === 0 ? (
              <div className="py-8 text-center text-[11px] text-muted-foreground">
                {cameraWallOpen ? "No vehicles captured across the camera wall yet." : "No vehicles captured on this camera yet."}
              </div>
            ) : (
              capturedVehicles.map((veh, idx) => {
                const hit = veh.match_status === "MATCHED";
                const estimated = veh.plate_verified === false;
                return (
                  <div
                    key={`${veh.camera_id}:${veh.id || idx}`}
                    onClick={() => {
                      if (cameraWallOpen) {
                        setSelectedCameraId(veh.camera_id);
                        setCameraWallOpen(false);
                      }
                      setActiveDetections([veh]);
                      setSelectedVehicleIndex(0);
                    }}
                    className={`grid min-h-16 grid-cols-[3rem_minmax(4.5rem,1fr)_3.5rem] items-center gap-1.5 border-t px-2.5 py-2.5 text-xs cursor-pointer transition-colors first:border-t-0 sm:grid-cols-[3rem_minmax(4.75rem,1.1fr)_minmax(4.25rem,0.9fr)_3rem_3.25rem] ${
                      hit
                        ? "border-red-500/30 bg-red-500/[0.07] hover:bg-red-500/[0.12]"
                        : "border-border/70 bg-background hover:bg-muted/35"
                    }`}
                  >
                    <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {new Date(veh.occurred_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                    </div>
                    <div className="min-w-0">
                      <div className={`truncate font-mono text-[11px] font-bold tracking-tight ${veh.plate_number ? "text-foreground" : "text-muted-foreground"}`}>
                        {veh.plate_number || "No plate read"}
                      </div>
                      <div className="mt-0.5 truncate text-[9px] text-muted-foreground sm:hidden">
                        {cameraWallOpen ? `${veh.camera_name ?? veh.camera_id} · ` : ""}{veh.vehicle_type}
                      </div>
                    </div>
                    <div className="hidden min-w-0 text-[9px] text-muted-foreground sm:block">
                      {cameraWallOpen && <div className="truncate font-semibold normal-case text-foreground" title={veh.camera_name ?? veh.camera_id}>{veh.camera_name ?? veh.camera_id}</div>}
                      <div className="truncate font-medium">{vehicleTypeLabel(veh.vehicle_type)}</div>
                    </div>
                    <div className="hidden items-center sm:flex">
                      {(() => {
                        // Captured into a local so the type guard's narrowing
                        // survives into the onClick closure below -- TS does
                        // not carry a predicate's narrowing through a nested
                        // property access (veh.image_snapshot) across a
                        // function boundary, only through a plain variable.
                        const snapshot = veh.image_snapshot;
                        return isDisplayableSnapshot(snapshot) ? (
                        <button
                          type="button"
                          className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                          title="Click to enlarge captured image"
                          aria-label="Enlarge captured vehicle image"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEnlargedSnapshot(snapshot);
                          }}
                        >
                          <img
                            src={snapshot}
                            alt="Captured vehicle"
                            className="h-9 w-12 rounded-md border border-slate-700 object-cover transition-colors hover:border-cyan-400"
                          />
                        </button>
                      ) : (
                        <div className="flex h-9 w-12 shrink-0 items-center justify-center rounded-md border border-slate-800 bg-slate-900">
                          <CarIcon className="h-4 w-4 text-slate-500" />
                        </div>
                        );
                      })()}
                    </div>
                    <div className="w-full justify-self-end text-right">
                      {hit ? (
                        <Badge variant="destructive" className="whitespace-nowrap px-2 py-0.5 text-[9px]">
                          HIT
                        </Badge>
                      ) : estimated ? (
                        <Badge
                          variant="outline"
                          className="whitespace-nowrap border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] text-amber-700"
                        >
                          ESTIMATE
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="whitespace-nowrap border-emerald-500/30 px-2 py-0.5 text-[9px] text-emerald-600"
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

        {incidentsPanel}
      </div>

      <div className="grid min-w-0 gap-4 xl:col-span-2 xl:grid-cols-2">
      {trafficPanel}

      <Card className="min-h-[22rem] min-w-0 gap-0 overflow-hidden border py-0 shadow-sm xl:h-[22rem]">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
          <div className="min-w-0">
            <CardTitle className="text-[15px] font-semibold tracking-tight">Vehicle Type Distribution</CardTitle>
            <CardDescription className="mt-1 truncate text-[11px]">
              {distributionScope} · {distributionLiveState}
            </CardDescription>
          </div>
          <Badge variant="outline" className="px-3 py-1 text-[10px] font-medium">Live session</Badge>
        </CardHeader>
        <CardContent className="grid min-h-0 flex-1 gap-4 px-5 py-3 sm:grid-cols-[8.5rem_1fr] sm:items-center">
          <div className="flex flex-col items-center justify-center gap-2 text-center">
            <div
              className="relative flex h-28 w-28 items-center justify-center rounded-full shadow-inner"
              style={{ background: distributionBackground }}
              role="img"
              aria-label={`${vehicleTypeTotal} vehicles grouped by type`}
            >
              <div className="flex h-16 w-16 flex-col items-center justify-center rounded-full border bg-card shadow-sm">
                <strong className="font-mono text-xl font-bold tabular-nums">{vehicleTypeTotal}</strong>
                <span className="text-[10px] text-muted-foreground">Total</span>
              </div>
            </div>
            <div className="text-[10px] leading-4 text-muted-foreground">
              <div><strong className="text-foreground">{inViewCount}</strong> currently in view</div>
              <div className="max-w-32 truncate">
                {latestSessionCapture
                  ? `Last capture ${new Date(latestSessionCapture.occurred_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`
                  : "Waiting for first capture"}
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-2.5">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-muted/25 px-2 py-2 text-center">
                <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Plates read</div>
                <div className="font-mono text-base font-bold tabular-nums">{readablePlateCount}</div>
              </div>
              <div className={`rounded-lg px-2 py-2 text-center ${watchlistHitCount > 0 ? "bg-red-50 text-red-700 dark:bg-red-950/30" : "bg-muted/25"}`}>
                <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Watchlist hits</div>
                <div className="font-mono text-base font-bold tabular-nums">{watchlistHitCount}</div>
              </div>
              <div className="min-w-0 rounded-lg bg-muted/25 px-2 py-2 text-center">
                <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Dominant</div>
                <div className="truncate text-[11px] font-bold" title={dominantType ? vehicleTypeLabel(dominantType[0]) : "No data"}>
                  {dominantType ? vehicleTypeLabel(dominantType[0]) : "No data"}
                </div>
                <div className="text-[9px] text-muted-foreground">{dominantPercentage}%</div>
              </div>
            </div>

            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {vehicleTypeEntries.length > 0 ? vehicleTypeEntries.map(([type, count], index) => {
                const percentage = vehicleTypeTotal > 0 ? Math.round((count / vehicleTypeTotal) * 100) : 0;
                return (
                  <div key={type} className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-muted/25 px-2.5 py-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: distributionColors[index % distributionColors.length] }}
                      />
                      <span className="truncate text-[10px] font-semibold" title={vehicleTypeLabel(type)}>{vehicleTypeLabel(type)}</span>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="font-mono text-[11px] font-bold tabular-nums">{count}</span>
                      <span className="ml-1 text-[8px] text-muted-foreground">{percentage}%</span>
                    </div>
                  </div>
                );
              }) : (
                <div className="col-span-full rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  Vehicle distribution will appear after detections begin in this scope.
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
