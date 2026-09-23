import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CameraIcon, InfoIcon, RotateCcwIcon, SearchIcon, UploadCloudIcon, UsersIcon, VideoIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageShell } from "@/components/ibvap/page-shell";
import { CameraFeed } from "@/components/ibvap/camera-feed";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useClient } from "@/client/context";
import { api } from "@/lib/api";
import { onLive, type PeopleExtra } from "@/lib/live";
import { useResource } from "@/lib/use-resource";

const PEOPLE_AI_BASE = "http://127.0.0.1:8002";

// Not measured against a real clip (claude.md §7's rule applies here too) --
// a starting point for "confident enough to call it a match" versus "shown,
// but not claimed." Lower to catch more candidates at the cost of more false
// positives from similarly-dressed people; raise to demand a closer match.
const TARGET_MATCH_THRESHOLD = 0.75;

type SourceMode = "media" | "live" | "upload";

interface ScannerTrack {
  key: string;
  personId: string | null;
  confidence: number;
  bbox: [number, number, number, number];
  trail: Array<[number, number]>;
  ageSeconds: number;
  /** How closely this crop's clothing colour matches the target search's
   * reference photo, 0..1. Absent when no target search is active. */
  targetScore: number | null;
}

/** Deterministic per-identity colour -- same hash shape as camera-feed.tsx's
 * colourFor(), so a person reads the same colour here as on a live camera tile. */
function colourFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 85%, 60%)`;
}

/**
 * People, tracked within one camera -- or one uploaded clip.
 *
 * WHAT THIS IS: the shared pass's ByteTrack identities, folded by
 * `modules/multi_human.py` into a stable "P<n>" label that can survive a
 * short occlusion or a re-entry, with the recent path each one has walked.
 * It answers "how many, where, and for how long" on one feed or one file.
 *
 * WHAT THIS IS NOT, and the page says so out loud: recognition. `person_id`
 * comes from an HSV colour-histogram signature (`modules/reid.py`'s
 * `HistogramReID`) -- real, measurable appearance evidence, matched against
 * physical plausibility (could this identity actually be here, given where
 * it last was and how much time passed), but colour, not a face or a name.
 * Two people in similar-coloured clothing can be told apart most of the
 * time and occasionally will not be; that is the honest ceiling of this
 * signal, not a bug to chase away.
 *
 * THREE SOURCES, ONE DRAWING CONTRACT: a shared camera reads its tracks off
 * the vision service's live channel (main.py, module="multi_human") via
 * CameraFeed -- the same component and the same `person_id`/`trail` fields
 * every other service page uses. A webcam or an uploaded clip has no vision
 * service watching it, so this page runs the identical multi_human module
 * itself, over HTTP, against `people_ai_service.py` (port 8002) -- the
 * people equivalent of the ANPR page's local scanner, kept in its own file
 * for the same reason people_run.py and run.py always have been (see
 * ibvap/README.md): a shared entry point between the two domains is how one
 * silently loses its detector to the other.
 *
 * TARGET SEARCH: an operator can upload a reference photo of one person and
 * every subsequent frame scores each tracked person against it
 * (`people_ai_service.py`'s POST /target) -- the SAME colour signature
 * `person_id` itself is built from, just compared against a photo instead of
 * another track's history. It only works for "Live camera" and "Upload
 * video" right now, because those are the two sources this page runs
 * multi_human against itself; "Cameras" reads pre-computed tracks off the
 * vision service's own channel, which does not compute a target score.
 * Said here in code and in the UI copy alike: this is clothing-colour
 * matching, not face recognition, and the score is shown for every
 * candidate rather than collapsed into a single silent "found" flag.
 */
export function PeopleScreen() {
  const { media } = useClient();
  const hub = useResource(() => api.mediaCameras(), []);
  const cameras = hub.data?.cameras ?? [];
  const [mode, setMode] = useState<SourceMode>("media");
  const [cameraId, setCameraId] = useState("");
  const [tracks, setTracks] = useState<ScannerTrack[]>([]);
  const [totalPeople, setTotalPeople] = useState(0);
  const [modelOnline, setModelOnline] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [fileName, setFileName] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const targetFileRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanBusy = useRef(false);
  const seenPeople = useRef(new Set<string>());

  // Target search: who the operator uploaded a reference photo of, if anyone.
  const [targetPhoto, setTargetPhoto] = useState<string | null>(null);
  const [targetConfidence, setTargetConfidence] = useState<number | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [targetBusy, setTargetBusy] = useState(false);

  useEffect(() => {
    if (cameraId || cameras.length === 0) return;
    const first = cameras.find((camera) => camera.ready && camera.seeded) ?? cameras[0];
    if (first) setCameraId(first.id);
  }, [cameraId, cameras]);

  const selectedCamera = cameras.find((camera) => camera.id === cameraId) ?? null;

  const resetSession = useCallback(() => {
    setTracks([]);
    setTotalPeople(0);
    seenPeople.current.clear();
  }, []);

  const acceptTracks = useCallback((next: ScannerTrack[]) => {
    setTracks(next);
    for (const track of next) {
      if (track.personId && !seenPeople.current.has(track.personId)) {
        seenPeople.current.add(track.personId);
        setTotalPeople((count) => count + 1);
      }
    }
  }, []);

  // "Cameras" mode: the SAME live channel and the SAME CameraFeed component
  // every other service page uses -- this effect only feeds the stats strip.
  // targetScore is always null here: the vision service's own multi_human
  // instance has no reference photo to score against (see the module
  // docstring on why target search is scoped to live camera/upload only).
  useEffect(() => {
    if (mode !== "media" || !cameraId) return;
    return onLive(cameraId, "multi_human", (observation) => {
      acceptTracks(observation.tracks.map((track, index): ScannerTrack => {
        const extra = track.extra as PeopleExtra;
        return {
          key: extra.track_ref ?? `${cameraId}:${track.track_id ?? index}`,
          personId: extra.person_id ?? null,
          confidence: track.confidence,
          bbox: track.bbox,
          trail: extra.trail ?? [],
          ageSeconds: extra.age_seconds ?? 0,
          targetScore: null,
        };
      }));
    });
  }, [acceptTracks, cameraId, mode]);

  const setTarget = useCallback(async (file?: File) => {
    if (!file) return;
    setTargetBusy(true);
    setTargetError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const response = await fetch(`${PEOPLE_AI_BASE}/target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      const result = await response.json() as { confidence?: number; detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "could not read the reference photo");
      setTargetPhoto(dataUrl);
      setTargetConfidence(result.confidence ?? null);
    } catch (error) {
      setTargetError(error instanceof Error ? error.message : "could not set the target photo");
      setTargetPhoto(null);
      setTargetConfidence(null);
    } finally {
      setTargetBusy(false);
    }
  }, []);

  const clearTarget = useCallback(() => {
    setTargetPhoto(null);
    setTargetConfidence(null);
    setTargetError(null);
    void fetch(`${PEOPLE_AI_BASE}/target`, { method: "DELETE" }).catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch(`${PEOPLE_AI_BASE}/health`);
        if (active) setModelOnline(response.ok);
      } catch {
        if (active) setModelOnline(false);
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
      const response = await fetch(`${PEOPLE_AI_BASE}/detect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: canvas.toDataURL("image/jpeg", 0.86) }),
      });
      if (!response.ok) throw new Error("people-tracking service unavailable");
      const result = await response.json() as { tracks: Array<{
        track_id?: number | null;
        confidence: number;
        bbox: [number, number, number, number];
        extra: {
          track_ref?: string; person_id?: string | null;
          trail?: Array<[number, number]>; age_seconds?: number;
          target_score?: number | null;
        };
      }> };
      acceptTracks(result.tracks.map((item, index) => ({
        key: item.extra.track_ref ?? `local:${item.track_id ?? index}`,
        personId: item.extra.person_id ?? null,
        confidence: item.confidence,
        bbox: item.bbox,
        trail: item.extra.trail ?? [],
        ageSeconds: item.extra.age_seconds ?? 0,
        targetScore: item.extra.target_score ?? null,
      })));
      setModelOnline(true);
    } catch {
      setModelOnline(false);
    } finally {
      scanBusy.current = false;
    }
  }, [acceptTracks]);

  useEffect(() => {
    if (mode === "media" || !playing || !modelOnline) return;
    const timer = window.setInterval(() => void scanFrame(), 750);
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
    // A fresh clip's first person must not be folded into an identity left
    // over from whatever was scanned before it -- see people_ai_service.py's
    // /reset docstring for why that would otherwise happen silently.
    void fetch(`${PEOPLE_AI_BASE}/reset`, { method: "POST" }).catch(() => {});
  };

  const distinctPeople = useMemo(() => totalPeople, [totalPeople]);
  const targetActive = mode !== "media" && targetPhoto !== null;
  const bestMatch = useMemo(() => {
    if (!targetActive) return null;
    return tracks.reduce<ScannerTrack | null>((best, track) => {
      if (track.targetScore == null) return best;
      if (!best || track.targetScore > (best.targetScore ?? 0)) return track;
      return best;
    }, null);
  }, [tracks, targetActive]);
  const bestMatchConfirmed = Boolean(bestMatch && (bestMatch.targetScore ?? 0) >= TARGET_MATCH_THRESHOLD);

  return (
    <PageShell
      title="Human tracking"
      description="Select a camera, webcam or video file and follow each person with a stable label and movement trail."
    >
      <input ref={fileRef} type="file" accept="video/*" className="hidden"
        onChange={(event) => upload(event.target.files?.[0])} />
      <input ref={targetFileRef} type="file" accept="image/*" className="hidden"
        onChange={(event) => void setTarget(event.target.files?.[0])} />
      <canvas ref={canvasRef} className="hidden" />

      <Alert>
        <InfoIcon />
        <AlertTitle>Colour-based re-association, not recognition</AlertTitle>
        <AlertDescription>
          A "P&lt;n&gt;" label is an appearance match on clothing colour, gated
          on whether the identity could physically be at that position --
          real evidence, not a guess, but not a face or a name either. Two
          people dressed alike can occasionally be told apart imperfectly.
          Ids are never shared between cameras or between separate clips.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base"><SearchIcon className="size-4" /> Search for a person</CardTitle>
            {targetPhoto && (
              <Button size="sm" variant="ghost" onClick={clearTarget}><XIcon /> Clear</Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {mode === "media" ? (
            <p className="text-sm text-muted-foreground">
              Target search works on <strong>Live camera</strong> and <strong>Upload video</strong>
              {" "}-- switch source to use it. The shared camera view reads tracks the vision
              service already computed, which does not include a target comparison.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <button type="button" onClick={() => targetFileRef.current?.click()}
                className="flex h-20 w-20 flex-none items-center justify-center overflow-hidden rounded-md border-2 border-dashed text-muted-foreground hover:border-primary hover:text-primary">
                {targetPhoto ? (
                  <img src={targetPhoto} alt="Reference photo of the person being searched for" className="h-full w-full object-cover" />
                ) : (
                  <UploadCloudIcon className="size-6" />
                )}
              </button>
              <div className="min-w-0 flex-1 text-sm">
                {targetBusy && <p className="text-muted-foreground">Reading the reference photo…</p>}
                {!targetBusy && targetError && <p className="text-destructive">{targetError}</p>}
                {!targetBusy && !targetError && targetPhoto && (
                  <>
                    <p className="font-medium">
                      Searching for this person
                      {targetConfidence != null && (
                        <span className="ml-2 font-normal text-muted-foreground">
                          (detected at {(targetConfidence * 100).toFixed(0)}% in the photo)
                        </span>
                      )}
                    </p>
                    <p className="text-muted-foreground">
                      {bestMatch
                        ? bestMatchConfirmed
                          // The match score and multi_human's own "P<n>" label
                          // are two different confirmations -- an 83% target
                          // match is real evidence on its own, even while the
                          // track's stable identity is still in its own
                          // confirmation window. Never word this as if a high
                          // score were somehow provisional because of that.
                          ? `Best match in view: ${((bestMatch.targetScore ?? 0) * 100).toFixed(0)}%` +
                            (bestMatch.personId ? ` -- tracked as ${bestMatch.personId}` : " -- track id not yet confirmed")
                          : `Closest candidate: ${((bestMatch.targetScore ?? 0) * 100).toFixed(0)}% -- below the ${(TARGET_MATCH_THRESHOLD * 100).toFixed(0)}% match threshold`
                        : "No one currently in view to compare."}
                    </p>
                  </>
                )}
                {!targetBusy && !targetError && !targetPhoto && (
                  <p className="text-muted-foreground">
                    Upload a photo of one person -- clothing visible, ideally filling most of
                    the frame -- and every tracked person is scored against it by appearance.
                    This is colour matching, not face recognition.
                  </p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">Tracking source</CardTitle>
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
              cameraId && <CameraFeed cameraId={cameraId} whepBase={media?.whepBase} module="multi_human" className="border-0" />
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

                {/* Trails, as one continuous SVG polyline per identity -- drawn
                    under the boxes, same layering as camera-feed.tsx. When a
                    target search is active, everyone but the confirmed match
                    fades back so the one trail that matters reads at a glance. */}
                <svg viewBox="0 0 1 1" preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 h-full w-full">
                  {tracks.filter((t) => t.trail.length > 1).map((t) => {
                    const isMatch = bestMatchConfirmed && t.key === bestMatch?.key;
                    const dimmed = targetActive && !isMatch;
                    return (
                      <polyline key={`trail-${t.key}`}
                        points={t.trail.map(([x, y]) => `${x},${y}`).join(" ")}
                        fill="none" stroke={isMatch ? "#ef4444" : colourFor(t.personId ?? t.key)}
                        strokeOpacity={dimmed ? 0.25 : 1}
                        strokeWidth={isMatch ? 0.01 : 0.006} vectorEffect="non-scaling-stroke" />
                    );
                  })}
                </svg>

                {tracks.map((item) => {
                  const isMatch = bestMatchConfirmed && item.key === bestMatch?.key;
                  const dimmed = targetActive && !isMatch;
                  const colour = isMatch ? "#ef4444" : colourFor(item.personId ?? item.key);
                  const label = targetActive && item.targetScore != null
                    ? (isMatch ? "TARGET " : "") + `${(item.targetScore * 100).toFixed(0)}%`
                    : `${item.personId ?? "..."} ${(item.confidence * 100).toFixed(0)}%`;
                  return (
                    <div key={item.key} className="pointer-events-none absolute"
                      style={{
                        border: `${isMatch ? 3 : 2}px solid ${colour}`,
                        opacity: dimmed ? 0.4 : 1,
                        boxShadow: isMatch ? "0 0 0 2px rgba(239,68,68,0.35)" : undefined,
                        left: `${item.bbox[0] * 100}%`, top: `${item.bbox[1] * 100}%`,
                        width: `${(item.bbox[2] - item.bbox[0]) * 100}%`, height: `${(item.bbox[3] - item.bbox[1]) * 100}%`,
                      }}>
                      <span className="absolute -top-6 left-0 whitespace-nowrap px-1.5 py-0.5 text-[11px] font-semibold text-slate-950"
                        style={{ backgroundColor: colour }}>
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {mode !== "media" && (
            <div className="flex items-center justify-between gap-3">
              <Badge variant={modelOnline ? "secondary" : "destructive"}>
                {modelOnline ? "PERSON TRACKING ONLINE" : "TRACKING OFFLINE (port 8002)"}
              </Badge>
              <div className="flex items-center gap-2">
                {mode === "upload" && videoUrl && (
                  <Button size="sm" variant="outline" onClick={() => upload(fileRef.current?.files?.[0] ?? undefined)}>
                    <RotateCcwIcon /> Restart clip
                  </Button>
                )}
                {mode === "upload" && videoUrl && (
                  <Button size="sm" onClick={() => {
                    if (!videoRef.current) return;
                    if (playing) videoRef.current.pause();
                    else void videoRef.current.play();
                  }}>
                    {playing ? "Pause" : "Play & track"}
                  </Button>
                )}
              </div>
            </div>
          )}
          {!modelOnline && mode !== "media" && (
            <p className="text-xs text-muted-foreground">
              Run <code>ibvap\run-people-ai.ps1</code>, then refresh this page.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Metric icon={UsersIcon} title="Distinct people" value={distinctPeople} detail="Unique identities this session" />
        <Metric icon={UsersIcon} title="Current view" value={tracks.length} detail="People visible now" />
      </div>
    </PageShell>
  );
}

function Metric({ icon: Icon, title, value, detail }:
  { icon: typeof UsersIcon; title: string; value: number; detail: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="rounded-full bg-primary/10 p-3"><Icon className="size-5 text-primary" /></div>
        <div><p className="text-xs text-muted-foreground">{title}</p><p className="text-2xl font-semibold">{value}</p><p className="text-xs text-muted-foreground">{detail}</p></div>
      </CardContent>
    </Card>
  );
}
