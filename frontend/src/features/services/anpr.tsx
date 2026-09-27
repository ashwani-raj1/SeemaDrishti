import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CameraIcon, CarFrontIcon, CrosshairIcon, ImageIcon, ListOrderedIcon, PlayIcon, UploadCloudIcon, VideoIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageShell } from "@/components/ibvap/page-shell";
import { CameraFeed } from "@/components/ibvap/camera-feed";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useClient } from "@/client/context";
import { api } from "@/lib/api";
import { onLive, type AnprExtra } from "@/lib/live";
import { useResource } from "@/lib/use-resource";

type SourceMode = "media" | "live" | "upload";

interface ScannerDetection {
  key: string;
  vehicleType: string;
  confidence: number;
  bbox: [number, number, number, number];
  plate?: {
    text: string;
    confidence: number;
    bbox: [number, number, number, number];
    source?: "ocr" | "llm";
    verified?: boolean;
    model?: string | null;
  };
  snapshot?: string;
}

interface PlateRead {
  key: string;
  plate: string;
  vehicleType: string;
  confidence: number;
  camera: string;
  snapshot?: string;
  source?: "ocr" | "llm";
  verified?: boolean;
}

export function AnprScreen() {
  const { media } = useClient();
  const hub = useResource(() => api.mediaCameras(), []);
  const cameras = hub.data?.cameras ?? [];
  const [mode, setMode] = useState<SourceMode>("media");
  const [cameraId, setCameraId] = useState<string>("");
  const [detections, setDetections] = useState<ScannerDetection[]>([]);
  const [plateReads, setPlateReads] = useState<PlateRead[]>([]);
  const [selectedReadKey, setSelectedReadKey] = useState<string | null>(null);
  const [enlargedSnapshot, setEnlargedSnapshot] = useState<string | null>(null);
  const [totalVehicles, setTotalVehicles] = useState(0);
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({});
  const [modelOnline, setModelOnline] = useState(false);
  const [aiFallbackOnline, setAiFallbackOnline] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [fileName, setFileName] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanBusy = useRef(false);
  const seenVehicles = useRef(new Set<string>());
  const seenPlates = useRef(new Set<string>());

  useEffect(() => {
    if (cameraId || cameras.length === 0) return;
    const first = cameras.find((camera) => camera.ready && camera.seeded) ?? cameras[0];
    if (first) setCameraId(first.id);
  }, [cameraId, cameras]);

  const selectedCamera = cameras.find((camera) => camera.id === cameraId) ?? null;

  const resetSession = useCallback(() => {
    setDetections([]);
    setPlateReads([]);
    setSelectedReadKey(null);
    setTotalVehicles(0);
    setTypeCounts({});
    seenVehicles.current.clear();
    seenPlates.current.clear();
  }, []);

  const acceptDetections = useCallback((next: ScannerDetection[], camera: string) => {
    setDetections(next);
    for (const detection of next) {
      if (!seenVehicles.current.has(detection.key)) {
        seenVehicles.current.add(detection.key);
        setTotalVehicles((count) => count + 1);
        setTypeCounts((counts) => ({
          ...counts,
          [detection.vehicleType]: (counts[detection.vehicleType] ?? 0) + 1,
        }));
      }
      if (detection.plate?.text) {
        const key = `${detection.key}:${detection.plate.text}`;
        if (!seenPlates.current.has(key)) {
          seenPlates.current.add(key);
          setPlateReads((reads) => [{
            key,
            plate: detection.plate!.text,
            vehicleType: detection.vehicleType,
            confidence: detection.plate!.confidence,
            camera,
            snapshot: detection.snapshot,
            source: detection.plate!.source ?? "ocr",
            verified: detection.plate!.verified ?? true,
          }, ...reads].slice(0, 50));
          setSelectedReadKey(key);
        } else if (detection.plate.verified !== false) {
          // A later local OCR read upgrades an earlier AI estimate for the
          // same track/text instead of leaving the unverified label behind.
          setPlateReads((reads) => reads.map((read) => read.key === key ? {
            ...read,
            confidence: detection.plate!.confidence,
            snapshot: detection.snapshot ?? read.snapshot,
            source: detection.plate!.source ?? "ocr",
            verified: true,
          } : read));
        }
      }
    }
  }, []);

  useEffect(() => {
    if (mode !== "media" || !cameraId) return;
    return onLive(cameraId, "anpr", (observation) => {
      acceptDetections(observation.tracks.map((track, index) => {
        const extra = track.extra as AnprExtra;
        return {
          key: extra.track_ref ?? `${cameraId}:${track.track_id ?? index}`,
          vehicleType: extra.vehicle_type ?? "vehicle",
          confidence: track.confidence,
          bbox: track.bbox,
          plate: extra.plate ? {
            text: extra.plate.text,
            confidence: extra.plate.confidence,
            bbox: extra.plate.bbox,
          } : undefined,
        };
      }), selectedCamera?.name ?? cameraId);
    });
  }, [acceptDetections, cameraId, mode, selectedCamera?.name]);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch("http://127.0.0.1:8001/health");
        const health = response.ok ? await response.json() as { llm_fallback?: boolean } : null;
        if (active) {
          setModelOnline(response.ok);
          setAiFallbackOnline(Boolean(health?.llm_fallback));
        }
      } catch {
        if (active) {
          setModelOnline(false);
          setAiFallbackOnline(false);
        }
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (mode !== "live") {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      return;
    }
    let cancelled = false;
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((stream) => {
        if (cancelled) return stream.getTracks().forEach((track) => track.stop());
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setPlaying(true);
      })
      .catch(() => setPlaying(false));
    return () => { cancelled = true; };
  }, [mode]);

  const scanFrame = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth || scanBusy.current) return;
    scanBusy.current = true;
    try {
      const scale = Math.min(1, 960 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      const response = await fetch("http://127.0.0.1:8001/detect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image: canvas.toDataURL("image/jpeg", 0.86),
          source_id: mode === "live" ? "service-live-camera" : `upload:${fileName || "video"}`,
        }),
      });
      if (!response.ok) throw new Error("ANPR service unavailable");
      const result = await response.json() as { detections: Array<{
        track_id?: number | null;
        track_key?: string;
        vehicle_type: string;
        confidence: number;
        bbox: [number, number, number, number];
        plate?: { text: string; confidence: number; bbox: [number, number, number, number]; source?: "ocr" | "llm"; verified?: boolean; model?: string | null };
      }> };
      const snapshotFor = (bbox: [number, number, number, number]) => {
        const x1 = Math.max(0, Math.floor(bbox[0] * canvas.width));
        const y1 = Math.max(0, Math.floor(bbox[1] * canvas.height));
        const x2 = Math.min(canvas.width, Math.ceil(bbox[2] * canvas.width));
        const y2 = Math.min(canvas.height, Math.ceil(bbox[3] * canvas.height));
        if (x2 <= x1 || y2 <= y1) return undefined;
        const crop = document.createElement("canvas");
        crop.width = x2 - x1;
        crop.height = y2 - y1;
        const context = crop.getContext("2d");
        if (!context) return undefined;
        context.drawImage(canvas, x1, y1, crop.width, crop.height, 0, 0, crop.width, crop.height);
        return crop.toDataURL("image/jpeg", 0.9);
      };
      acceptDetections(result.detections.map((item, index) => ({
        key: item.track_key ?? `local:${item.track_id ?? index}`,
        vehicleType: item.vehicle_type,
        confidence: item.confidence,
        bbox: item.bbox,
        plate: item.plate,
        snapshot: snapshotFor(item.plate?.bbox ?? item.bbox),
      })), mode === "live" ? "Live camera" : fileName || "Uploaded video");
      setModelOnline(true);
    } catch {
      setModelOnline(false);
    } finally {
      scanBusy.current = false;
    }
  }, [acceptDetections, fileName, mode]);

  useEffect(() => {
    if (mode === "media" || !playing || !modelOnline) return;
    const timer = window.setInterval(() => void scanFrame(), 850);
    return () => window.clearInterval(timer);
  }, [mode, modelOnline, playing, scanFrame]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  const chooseMode = (next: SourceMode) => {
    setMode(next);
    setPlaying(next === "media");
    resetSession();
  };

  const upload = (file?: File) => {
    if (!file) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    setFileName(file.name);
    setMode("upload");
    resetSession();
  };

  const typeSummary = useMemo(
    () => Object.entries(typeCounts).sort((a, b) => b[1] - a[1]),
    [typeCounts],
  );
  const selectedRead = plateReads.find((read) => read.key === selectedReadKey) ?? plateReads[0] ?? null;

  return (
    <PageShell
      title="Vehicle & number plate detection"
      description="Select a camera or video source, detect each vehicle once, and read visible registration plates."
    >
      <input ref={fileRef} type="file" accept="video/*" className="hidden"
        onChange={(event) => upload(event.target.files?.[0])} />
      <canvas ref={canvasRef} className="hidden" />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">ANPR source</CardTitle>
            <div className="flex gap-2">
              <Button size="sm" variant={mode === "media" ? "default" : "outline"} onClick={() => chooseMode("media")}>
                <VideoIcon /> Cameras
              </Button>
              <Button size="sm" variant={mode === "live" ? "default" : "outline"} onClick={() => chooseMode("live")}>
                <CameraIcon /> Live camera
              </Button>
              <Button size="sm" variant={mode === "upload" ? "default" : "outline"} onClick={() => fileRef.current?.click()}>
                <UploadCloudIcon /> Upload video
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {mode === "media" && (
            <div className="flex flex-wrap items-center gap-3">
              <Select value={cameraId} onValueChange={(value) => { setCameraId(value); resetSession(); }}>
                <SelectTrigger className="w-[300px]"><SelectValue placeholder="Select camera" /></SelectTrigger>
                <SelectContent>
                  {cameras.map((camera) => (
                    <SelectItem key={camera.id} value={camera.id}>{camera.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedCamera && (
                <Badge variant={selectedCamera.ready ? "secondary" : "destructive"}>
                  {selectedCamera.name} · {selectedCamera.ready ? "LIVE" : "NO FEED"}
                </Badge>
              )}
            </div>
          )}

          <div className="relative overflow-hidden rounded-lg bg-black">
            {mode === "media" ? (
              cameraId && <CameraFeed cameraId={cameraId} whepBase={media?.whepBase} module="anpr" className="border-0" />
            ) : (
              <div className="relative aspect-video">
                {mode === "upload" && !videoUrl ? (
                  <button type="button" onClick={() => fileRef.current?.click()}
                    className="absolute inset-0 flex w-full flex-col items-center justify-center gap-2 text-white/70">
                    <UploadCloudIcon className="size-9" />
                    <span>Choose a video</span>
                  </button>
                ) : (
                  <video ref={videoRef} src={mode === "upload" ? videoUrl ?? undefined : undefined}
                    autoPlay={mode === "live"} muted playsInline
                    onLoadedMetadata={() => {
                      if (mode === "upload" && videoRef.current) {
                        void videoRef.current.play();
                        setPlaying(true);
                      }
                    }}
                    onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                    className="h-full w-full object-contain" />
                )}
                {detections.map((item) => (
                  <div key={item.key} className="pointer-events-none absolute border-2 border-cyan-400"
                    style={{ left: `${item.bbox[0] * 100}%`, top: `${item.bbox[1] * 100}%`, width: `${(item.bbox[2] - item.bbox[0]) * 100}%`, height: `${(item.bbox[3] - item.bbox[1]) * 100}%` }}>
                    <span className="absolute -top-6 left-0 whitespace-nowrap bg-cyan-400 px-1.5 py-0.5 text-[11px] font-semibold text-slate-950">
                      {item.vehicleType} {(item.confidence * 100).toFixed(0)}% {item.plate?.text ? `· ${item.plate.text}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {mode !== "media" && (
            <div className="flex items-center justify-between gap-3">
              <Badge variant={modelOnline ? "secondary" : "destructive"}>
                {modelOnline ? `YOLO + OCR ONLINE${aiFallbackOnline ? " · AI FALLBACK READY" : ""}` : "YOLO + OCR OFFLINE (port 8001)"}
              </Badge>
              {mode === "upload" && videoUrl && (
                <Button size="sm" onClick={() => {
                  if (!videoRef.current) return;
                  if (playing) videoRef.current.pause();
                  else void videoRef.current.play();
                }}>
                  <PlayIcon /> {playing ? "Pause" : "Play & scan"}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Metric title="Total vehicles" value={totalVehicles} detail="Unique tracked vehicles" />
        <Metric title="Current view" value={detections.length} detail="Vehicles visible now" />
        <Metric title="Vehicle types" value={typeSummary.reduce((sum, [, count]) => sum + count, 0)}
          detail={typeSummary.map(([type, count]) => `${type}: ${count}`).join(" · ") || "Waiting for vehicles"} />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base"><ListOrderedIcon className="size-4" /> Captured Vehicles ({plateReads.length})</CardTitle>
            {plateReads.length > 0 && <Button variant="ghost" size="sm" onClick={resetSession}>Reset Count</Button>}
          </div>
        </CardHeader>
        <CardContent>
          {plateReads.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No vehicles with a readable plate captured yet.</p>
          ) : (
            <div className="divide-y rounded-md border">
              {plateReads.map((read) => (
                <button type="button" key={read.key} onClick={() => setSelectedReadKey(read.key)}
                  className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left transition-colors hover:bg-muted/50">
                  <div className="flex items-center gap-3">
                    {read.snapshot ? <img src={read.snapshot} alt={`${read.plate} plate thumbnail`} className="h-10 w-16 rounded border bg-black object-contain" /> : <div className="flex h-10 w-16 items-center justify-center rounded border bg-slate-950"><CarFrontIcon className="size-4 text-slate-400" /></div>}
                    <div><p className="font-mono text-lg font-semibold">{read.plate}</p><p className="text-xs text-muted-foreground">{read.camera}</p></div>
                  </div>
                  <div className="text-right"><p className="text-sm capitalize">{read.vehicleType}</p><p className="text-xs text-muted-foreground">{read.verified === false ? "AI estimate · unverified" : `OCR ${(read.confidence * 100).toFixed(0)}%`}</p></div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base"><CrosshairIcon className="size-4" /> Plate Snapshot & Optical License Plate OCR Breakdown</CardTitle>
            <Badge variant="secondary" className="font-mono">Real-Time ANPR</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid items-center gap-4 md:grid-cols-3">
            <div className="rounded-md border bg-slate-950 p-2 text-slate-100">
              <div className="mb-1 flex items-center justify-between px-1 font-mono text-[10px] text-slate-400"><span>PLATE SNAPSHOT</span><span className="text-cyan-400">{selectedRead?.vehicleType.toUpperCase() ?? "CAR"}</span></div>
              {selectedRead?.snapshot ? (
                <button type="button" className="w-full cursor-zoom-in" title="Click to enlarge plate photo" onClick={() => setEnlargedSnapshot(selectedRead.snapshot ?? null)}>
                  <img src={selectedRead.snapshot} alt="Captured number plate — click to enlarge" className="h-28 w-full rounded border border-slate-700 bg-black object-contain transition-colors hover:border-cyan-400" />
                </button>
              ) : (
                <div className="flex h-28 flex-col items-center justify-center gap-2 rounded border border-slate-800 text-xs text-slate-500"><ImageIcon className="size-6" /><span>Waiting for plate snapshot</span></div>
              )}
            </div>
            <div className="rounded-md border-2 border-slate-900 bg-amber-50 p-4 text-slate-900 shadow-inner">
              <div className="mb-2 flex items-center justify-between border-b border-slate-300 pb-1 text-[10px] font-bold text-slate-600"><span>IND</span><span>INDIA</span><span className="size-2 rounded-full bg-blue-600" /></div>
              <div className="text-center font-mono text-2xl font-bold tracking-[0.2em]">{selectedRead?.plate ?? "— — — — — —"}</div>
            </div>
            <div>
              <div className="mb-3 flex items-center justify-between text-sm"><span className="text-muted-foreground">{selectedRead?.verified === false ? "Vision estimate:" : "OCR Confidence:"}</span><span className={`font-mono font-semibold ${selectedRead?.verified === false ? "text-amber-600" : "text-emerald-600"}`}>{selectedRead ? (selectedRead.verified === false ? "UNVERIFIED" : `${(selectedRead.confidence * 100).toFixed(0)}%`) : "—"}</span></div>
              <div className="flex flex-wrap gap-1">
                {selectedRead?.plate.split("").map((character, index) => (
                  <div key={`${character}-${index}`} className="min-w-9 rounded border p-1 text-center"><div className="font-mono font-semibold">{character}</div><div className="text-[9px] text-muted-foreground">{selectedRead.verified === false ? "AI" : `${(selectedRead.confidence * 100).toFixed(0)}%`}</div></div>
                )) ?? <span className="text-sm text-muted-foreground">Character confidence will appear after a plate is read.</span>}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!enlargedSnapshot} onOpenChange={(open) => !open && setEnlargedSnapshot(null)}>
        <DialogContent className="max-w-4xl p-3">
          <DialogTitle className="px-2 text-sm">Captured number plate</DialogTitle>
          {enlargedSnapshot && <img src={enlargedSnapshot} alt="Enlarged captured number plate" className="max-h-[80vh] w-full rounded bg-black object-contain" />}
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function Metric({ title, value, detail }: { title: string; value: number; detail: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="rounded-full bg-primary/10 p-3"><CarFrontIcon className="size-5 text-primary" /></div>
        <div><p className="text-xs text-muted-foreground">{title}</p><p className="text-2xl font-semibold">{value}</p><p className="text-xs text-muted-foreground">{detail}</p></div>
      </CardContent>
    </Card>
  );
}
