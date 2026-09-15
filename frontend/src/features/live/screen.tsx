import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangleIcon, ArchiveIcon, ArrowLeftIcon, BarChart3Icon, CalendarIcon,
  CameraIcon, CarIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon,
  ChevronUpIcon, CrosshairIcon, DownloadIcon, ExpandIcon, FootprintsIcon,
  ImageIcon, MapIcon, MapPinIcon, MicIcon, MonitorPlayIcon, MoreHorizontalIcon,
  PauseIcon, PencilIcon, PlayIcon, PlusIcon, MinusIcon, SearchIcon, SignalIcon,
  Trash2Icon, UserRoundIcon, VideoIcon,
} from "lucide-react";
import { CameraFeed } from "@/components/ibvap/camera-feed";
import { CameraMap } from "@/components/ibvap/camera-map";
import { CameraAnalyticsDashboard } from "@/features/cameras/screen";
import { useClient } from "@/client/context";
import { onStream } from "@/lib/stream";
import { cn } from "@/lib/utils";
import type { Camera, IbvapEvent } from "@/lib/types";

type Layout = 1 | 4 | 6 | 8 | 12 | 16;
type Mode = "live" | "playback" | "analytics";

const layouts: Layout[] = [1, 4, 6, 8, 12, 16];

/**
 * A light, dense viewing station. Live view has no playback controls: video
 * moves to its own mode so no button implies the live WHEP stream is a DVR.
 */
export function LiveCamerasScreen() {
  const { cameras, media, site } = useClient();
  const navigate = useNavigate();
  const viewer = useRef<HTMLElement | null>(null);
  const [layout, setLayout] = useState<Layout>(6);
  const [mode, setMode] = useState<Mode>("live");
  const [selected, setSelected] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showMap, setShowMap] = useState(false);
  const [recent, setRecent] = useState<IbvapEvent[]>([]);

  useEffect(() => {
    setSelected((current) => [...new Set([...current, ...cameras.map((camera) => camera.id)])]);
  }, [cameras]);

  useEffect(
    () => onStream("event", (data) => {
      setRecent((current) => [data as IbvapEvent, ...current].slice(0, 100));
    }),
    [],
  );

  const activeCameras = useMemo(
    () => cameras.filter((camera) => selected.includes(camera.id)),
    [cameras, selected],
  );
  const visibleCameras = activeCameras.slice(0, layout === 1 ? 1 : layout);
  const matchedCameras = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? cameras.filter((camera) => camera.name.toLowerCase().includes(term)) : cameras;
  }, [cameras, search]);
  const tileGrid = layout === 1
    ? "grid-cols-1"
    : layout === 4 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await viewer.current?.requestFullscreen();
  }

  const changeNav = (next: string) => {
    if (next === "Maps") navigate("/map");
    else if (next === "Analytics") setMode("analytics");
    else if (next === "Playback") setMode("playback");
    else if (next === "Live View") setMode("live");
  };

  return (
    <main ref={viewer} className="h-full overflow-auto bg-[#eef4f8] text-[#132238]">
      <nav className="sticky top-0 z-20 flex min-w-max items-center gap-1.5 border-b border-[#c9d8e5] bg-white px-4 py-1.5 shadow-sm">
        {[
          [VideoIcon, "Live View"], [MapIcon, "Maps"], [MonitorPlayIcon, "Playback"],
          [ArchiveIcon, "Archives"], [BarChart3Icon, "Analytics"], [CrosshairIcon, "Administration"],
        ].map(([Icon, label]) => {
          const active =
            (label === "Live View" && mode === "live") ||
            (label === "Playback" && mode === "playback") ||
            (label === "Analytics" && mode === "analytics");
          return <button key={label} type="button" onClick={() => changeNav(label as string)} className={cn("flex items-center gap-1.5 rounded-[4px] px-4 py-2.5 text-xs font-semibold text-[#43556b] transition-colors hover:bg-[#eaf2f9]", active && "bg-[#3487f4] text-white shadow-[0_2px_7px_rgba(52,135,244,.35)]")}><Icon className="size-4" />{label}</button>;
        })}
      </nav>

      {mode === "analytics" ? <CameraAnalyticsDashboard /> : <div className={cn("grid gap-3 p-3", mode === "live" && "xl:grid-cols-[minmax(0,1fr)_300px]")}>
        <section className="min-w-0">
          {mode === "live" && <>
            <ViewerToolbar layout={layout} onLayout={setLayout} onFullscreen={toggleFullscreen} onMap={() => setShowMap((value) => !value)} mapVisible={showMap} />
            {showMap ? <InlineMap cameras={activeCameras} onClose={() => setShowMap(false)} /> : <div className={cn("mt-2 grid gap-2", tileGrid)}>
              {visibleCameras.map((camera, index) => <FeedTile key={camera.id} camera={camera} mediaBase={media?.whepBase} index={index} focused={focused === camera.id} onFocus={() => setFocused(camera.id)} />)}
              {visibleCameras.length === 0 && <EmptyWall />}
            </div>}
          </>}
          {mode === "playback" && <PlaybackStation cameras={activeCameras} mediaBase={media?.whepBase} events={recent} onBack={() => setMode("live")} />}
        </section>

        {mode === "live" && <aside className="flex flex-col gap-3">
          <CameraList cameras={matchedCameras} selected={selected} siteName={site?.name ?? "Camera group"} search={search} onSearch={setSearch} onToggle={(id, checked) => setSelected((current) => checked ? [...current, id] : current.filter((cameraId) => cameraId !== id))} />
          <PtzPanel camera={cameras.find((camera) => camera.id === focused) ?? null} />
        </aside>}
      </div>}
    </main>
  );
}

function ViewerToolbar({ layout, onLayout, onFullscreen, onMap, mapVisible }: { layout: Layout; onLayout: (value: Layout) => void; onFullscreen: () => void; onMap: () => void; mapVisible: boolean }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-[#c7d8e7] bg-white px-4 py-3 shadow-sm"><div className="mr-auto"><p className="text-[10px] font-semibold uppercase tracking-[.14em] text-blue-600">Real-time monitoring</p><h1 className="mt-0.5 text-2xl font-bold tracking-tight">Camera Viewer</h1></div><div className="flex items-center gap-2 text-xs text-[#52667d]"><span>Layout:</span><div className="flex overflow-hidden rounded-[4px] border border-[#b9cede]">{layouts.map((count) => <button key={count} type="button" aria-pressed={layout === count} onClick={() => onLayout(count)} className={cn("min-w-9 border-r border-[#c9d8e5] px-2.5 py-2 font-medium last:border-r-0 hover:bg-[#edf5fb]", layout === count && "bg-[#3487f4] text-white")}>{count}</button>)}</div></div><ControlButton icon={ExpandIcon} label="Fullscreen" onClick={onFullscreen} /><ControlButton icon={MapIcon} label={mapVisible ? "Show cameras" : "Show Map"} onClick={onMap} /></div>;
}

function ControlButton({ icon: Icon, label, onClick }: { icon: typeof ExpandIcon; label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex items-center gap-1.5 rounded-[4px] border border-[#b9cede] bg-white px-3 py-2 text-xs font-semibold text-[#304a65] hover:bg-[#edf5fb]"><Icon className="size-4" />{label}</button>;
}

function FeedTile({ camera, mediaBase, index, focused, onFocus }: { camera: Camera; mediaBase?: string; index: number; focused: boolean; onFocus: () => void }) {
  const number = String(index + 1).padStart(2, "0");
  return <article className={cn("relative min-w-0 overflow-hidden rounded-[5px] border-2 border-[#31546f] bg-black shadow-[0_2px_6px_rgba(33,57,78,.22)]", focused && "border-[#ffcf00] shadow-[0_0_10px_rgba(255,207,0,.45)]")}>
    <header className="absolute inset-x-0 top-0 z-10 flex items-start gap-2 bg-gradient-to-b from-[#06121e]/95 via-[#0b1c2b]/80 to-transparent px-3 pb-7 pt-2"><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-bold text-white">{camera.name}</h2><p className="truncate text-xs text-[#d2e0eb]">{camera.zones.map((zone) => zone.name).join(" · ") || "Camera feed"}</p></div><span className="flex shrink-0 items-center gap-1 rounded-full bg-[#004a2c]/85 px-2 py-1 text-[10px] font-bold text-[#28f28c]"><span className="size-1.5 rounded-full bg-[#13e878]" />LIVE</span><span className="font-mono text-xs text-[#e5eff7]">19:09:44</span><button type="button" onClick={onFocus} aria-label={`Focus ${camera.name}`} className="text-white hover:text-[#d7edff]"><ExpandIcon className="size-4" /></button></header>
    <CameraFeed cameraId={camera.id} streamPath={camera.streamPath} whepBase={mediaBase} zones={camera.zones} showBoxes className="aspect-[16/11] !rounded-none !border-0" />
    <footer className="absolute inset-x-0 bottom-0 z-10 flex items-center bg-gradient-to-t from-[#05080b]/95 via-[#05080b]/75 to-transparent px-3 pb-2 pt-8"><span className="font-mono text-xs font-semibold text-white">CAM {number}</span><div className="ml-auto flex items-center gap-3 text-white"><MicIcon className="size-4" /><CameraIcon className="size-4" /><span className="grid size-4 place-items-center rounded-full border-2 border-white"><span className="size-2 rounded-full bg-[#eb1818]" /></span><SignalIcon className="size-4 fill-current" /></div></footer>
  </article>;
}

function InlineMap({ cameras, onClose }: { cameras: Camera[]; onClose: () => void }) {
  return <div className="mt-2 rounded-md border border-[#c7d8e7] bg-white p-4 shadow-sm"><div className="mb-3 flex items-center"><div><h2 className="font-bold">Camera coverage map</h2><p className="text-sm text-[#63768a]">Select a camera from the sidebar to change the wall; this view shows its configured ground coverage.</p></div><button onClick={onClose} className="ml-auto rounded border border-[#b9cede] px-3 py-2 text-sm text-[#304a65] hover:bg-[#edf5fb]">Back to feeds</button></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{cameras.map((camera) => <div key={camera.id}><p className="mb-1 text-sm font-semibold">{camera.name}</p><CameraMap camera={camera} className="aspect-video w-full" /></div>)}</div></div>;
}

function PlaybackStation({ cameras, mediaBase, events, onBack }: { cameras: Camera[]; mediaBase?: string; events: IbvapEvent[]; onBack: () => void }) {
  const [cameraId, setCameraId] = useState(cameras[0]?.id ?? "");
  useEffect(() => {
    if (!cameras.some((camera) => camera.id === cameraId)) setCameraId(cameras[0]?.id ?? "");
  }, [cameras, cameraId]);
  const camera = cameras.find((item) => item.id === cameraId);
  const cameraEvents = events.filter((event) => event.cameraId === cameraId);
  if (!camera) return <EmptyWall />;
  return <div className="space-y-3 bg-[#f7faff] p-4 text-[#132238]">
    <header className="flex items-center gap-3"><button type="button" onClick={onBack} className="grid size-9 place-items-center rounded-md border border-[#c7d8e7] bg-white text-[#31516f] hover:bg-[#edf5fb]" aria-label="Back to live cameras"><ArrowLeftIcon className="size-4" /></button><div><p className="text-[10px] font-semibold uppercase tracking-[.14em] text-blue-600">Recorded footage</p><h1 className="text-2xl font-bold tracking-tight">Playback</h1></div></header>
    <div className="grid gap-3 xl:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="space-y-3"><PlaybackCalendar /><section className="rounded-md border border-[#c7d8e7] bg-white p-4 shadow-sm"><h2 className="text-base font-bold">Cameras</h2><div className="relative mt-3"><SearchIcon className="absolute left-3 top-2.5 size-4 text-[#71869b]"/><input placeholder="Search camera..." className="h-9 w-full rounded border border-[#b9cede] bg-[#f8fbfd] pl-9 pr-3 text-xs outline-none focus:border-[#3487f4]"/></div><div className="mt-3 space-y-1">{cameras.map(item => <button key={item.id} onClick={() => setCameraId(item.id)} className={cn("flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs font-semibold", item.id === cameraId ? "bg-[#e5f1ff] text-[#1268cc]" : "text-[#40566b] hover:bg-[#edf5fb]")}><VideoIcon className="size-4"/><span className="min-w-0 flex-1 truncate">{item.name}</span><i className="size-2 rounded-full bg-emerald-500"/></button>)}</div></section></aside>
      <section className="min-w-0 space-y-3"><ArchivePlayer camera={camera}/><PlaybackTimeline camera={camera} events={cameraEvents}/></section>
    </div>
  </div>;
}

function PlaybackCalendar() { return <section className="rounded-md border border-[#c7d8e7] bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><h2 className="text-base font-bold">Calendar</h2><CalendarIcon className="size-4 text-blue-600"/></div><div className="mt-3 flex items-center justify-between text-sm font-semibold"><ChevronLeftIcon className="size-4"/><span>September 2026</span><ChevronRightIcon className="size-4"/></div><div className="mt-3 grid grid-cols-7 gap-1 text-center text-[11px] text-[#607a94]">{"SMTWTFS".split("").map((day,index) => <span key={`${day}-${index}`} className="py-1 font-semibold">{day}</span>)}{Array.from({length:30},(_,index) => <span key={index} className={cn("grid h-7 place-items-center rounded", index === 12 ? "bg-[#1976f3] font-bold text-white" : index % 5 === 2 ? "text-[#1976f3]" : "")}>{index+1}</span>)}</div><div className="mt-4 flex gap-3 text-[10px] text-[#607a94]"><span className="flex items-center gap-1"><i className="size-2 rounded-full bg-blue-500"/>Recording</span><span className="flex items-center gap-1"><i className="size-2 rounded-full bg-amber-500"/>Event</span></div></section>; }

function PlaybackTimeline({ camera, events }: { camera: Camera; events: IbvapEvent[] }) { return <section className="rounded-md border border-[#c7d8e7] bg-white p-4 shadow-sm"><div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-base font-bold">Playback Timeline</h2><TimelineLegend colour="bg-blue-500" label="Motion"/><TimelineLegend colour="bg-emerald-500" label="Vehicle"/><TimelineLegend colour="bg-amber-500" label="Intrusion"/></div><div className="relative mt-5 h-10 rounded bg-[#dcedfc]"><div className="absolute inset-x-3 top-4 h-2 rounded bg-gradient-to-r from-blue-300 via-blue-500 to-blue-300"/>{events.slice(0,6).map((event,index)=><i key={event.id} title={event.kind} className="absolute top-3 size-4 rounded-full border-2 border-white bg-amber-500" style={{left:`${15+index*13}%`}}/>)}</div><div className="mt-2 flex justify-between text-[10px] text-[#7990a5]"><span>18:00</span><span>18:15</span><span>18:30</span><span>18:45</span><span>19:00</span></div><div className="mt-4 flex gap-2 overflow-hidden">{Array.from({length:6},(_,index)=><div key={index} className="relative h-18 min-w-32 flex-1 overflow-hidden rounded border border-[#d2e0eb] bg-slate-800"><CameraMap camera={camera} className="h-full w-full opacity-70"/><span className="absolute inset-x-0 bottom-0 bg-[#06121e]/75 px-1 py-0.5 font-mono text-[10px] text-white">18:{String(38+index).padStart(2,"0")}:00</span></div>)}</div></section>; }

/** Native file player backed by the console's byte-range archive endpoint. */
function ArchivePlayer({ camera }: { camera: Camera }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const src = `/archive/${encodeURIComponent(camera.id)}`;

  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
    setError(null);
  }, [src]);

  const toggle = async () => {
    const player = video.current;
    if (!player) return;
    if (player.paused) await player.play();
    else player.pause();
  };
  const seek = (next: number) => {
    if (video.current) video.current.currentTime = next;
    setCurrent(next);
  };
  const time = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  };

  return <section className="overflow-hidden rounded-md border border-[#c7d8e7] bg-[#06121e] shadow-sm">
    <div className="relative aspect-[16/8] min-h-[420px] bg-black">
      <div className="absolute inset-x-0 top-0 z-10 flex items-start gap-3 bg-gradient-to-b from-[#06121e]/95 via-[#06121e]/65 to-transparent p-4 text-white"><CarIcon className="mt-1 size-6" /><div className="min-w-0 flex-1"><h2 className="text-lg font-bold">{camera.name}</h2><p className="text-sm text-[#d4e1ed]">{camera.zones.map((zone) => zone.name).join(" · ") || "Camera recording"}</p></div><span className="rounded bg-[#071521]/85 px-3 py-1 font-mono text-sm">ARCHIVE</span><button type="button" onClick={() => void video.current?.requestFullscreen()} aria-label="Fullscreen playback" className="rounded bg-[#071521]/85 p-2"><ExpandIcon className="size-5" /></button></div>
      <video ref={video} src={src} preload="metadata" playsInline className="h-full w-full object-contain" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)} onError={() => setError("No local recording is available for this camera. Run media/configure.py after placing the clip in media/clips/.")} />
      {error && <div className="absolute inset-0 grid place-items-center bg-[#06121e]/90 p-6 text-center text-white"><div><ArchiveIcon className="mx-auto size-8 text-[#8ab5e4]" /><p className="mt-3 max-w-sm text-sm">{error}</p></div></div>}
      <div className="absolute bottom-0 left-0 z-10 m-3 rounded bg-[#071521]/85 px-3 py-2 text-xs text-white"><span className="flex items-center gap-2"><MapPinIcon className="size-5" />Local recording · {time(current)} / {duration ? time(duration) : "--:--"}</span></div>
    </div>
    <div className="flex flex-wrap items-center gap-4 bg-[#071827] px-4 py-3 text-white"><button type="button" onClick={() => seek(Math.max(0, current - 10))} aria-label="Back 10 seconds"><ChevronLeftIcon className="size-5" /></button><button type="button" onClick={() => void toggle()} aria-label={playing ? "Pause" : "Play"}>{playing ? <PauseIcon className="size-5 fill-current" /> : <PlayIcon className="size-5 fill-current" />}</button><span className="rounded border border-[#304d67] px-3 py-1 text-xs">1×</span><input aria-label="Playback position" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(current, duration || 0)} onChange={(event) => seek(Number(event.target.value))} disabled={!duration} className="min-w-40 flex-1 accent-[#1c7af3]" /><span className="font-mono text-sm">{time(current)} / {duration ? time(duration) : "--:--"}</span><ImageIcon className="size-5" /><MoreHorizontalIcon className="size-5" /></div>
  </section>;
}

function PlaybackFilter({ icon: Icon, label }: { icon: typeof CalendarIcon; label: string }) {
  return <button type="button" className="flex items-center gap-3 rounded-md border border-[#c7d8e7] bg-white px-4 py-3 text-sm font-semibold text-[#405870]"><Icon className="size-5" />{label}<ChevronDownIcon className="ml-3 size-4 text-[#7290aa]" /></button>;
}

function TimelineLegend({ colour, label }: { colour: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className={cn("size-2.5 rounded-full", colour)} />{label}</span>;
}

function AnalyticsCards({ values }: { values: number[] }) {
  const cards = [[FootprintsIcon, "Motion events", values[0], "text-red-500"], [AlertTriangleIcon, "Intrusion detections", values[1], "text-amber-500"], [CarIcon, "Vehicle detections", values[2], "text-blue-600"], [UserRoundIcon, "Loitering events", values[3], "text-violet-600"]] as const;
  return <section className="rounded-md border border-[#c7d8e7] bg-white p-3 shadow-sm"><h2 className="font-bold">Playback Analytics</h2><div className="mt-4 grid grid-cols-2 gap-2 xl:grid-cols-4">{cards.map(([Icon, label, value, colour]) => <div key={label} className="rounded-md border border-[#deebf3] bg-[#f8fbfd] p-3"><Icon className={cn("size-6", colour)} /><p className="mt-2 text-xs text-[#62788f]">{label}</p><p className="mt-1 font-mono text-2xl font-bold text-[#1b3b59]">{value}</p><p className="text-xs text-[#71879a]">this session</p></div>)}</div></section>;
}

function EventTimeline({ events }: { events: IbvapEvent[] }) {
  return <section className="rounded-md border border-[#c7d8e7] bg-white p-3 shadow-sm"><div className="flex items-center"><h2 className="font-bold">Event Timeline</h2><span className="ml-auto text-xs font-semibold text-[#1877f2]">Current session</span></div><div className="mt-3 space-y-3">{events.slice(0, 4).map((event) => <div key={event.id} className="flex gap-3 text-sm"><span className="font-mono text-xs text-[#71879a]">{event.occurredAt.slice(11, 19)}</span><div><p className="font-medium">{event.kind.replaceAll("_", " ")}</p><p className="text-xs text-[#71879a]">{event.severity} confidence</p></div></div>)}{events.length === 0 && <p className="py-7 text-center text-sm text-[#71879a]">No events received this session.</p>}</div></section>;
}

function ClipMarkers({ events }: { events: IbvapEvent[] }) {
  return <section className="rounded-md border border-[#c7d8e7] bg-white p-3 shadow-sm"><div className="flex items-center"><h2 className="font-bold">Clip Markers</h2><button disabled className="ml-auto flex items-center gap-1 rounded border border-[#d2e0eb] px-2 py-1 text-xs text-[#71879a]"><PlusIcon className="size-3" />Add Marker</button></div><p className="mt-2 text-xs text-[#71879a]">Markers become available with a recording archive.</p><div className="mt-3 space-y-2">{events.slice(0, 3).map((event) => <div key={event.id} className="flex items-center gap-2 rounded border border-[#e0eaf1] p-2"><div className="grid size-10 place-items-center rounded bg-[#edf5fb]"><VideoIcon className="size-5 text-[#3975a5]" /></div><div className="min-w-0 flex-1"><p className="font-mono text-xs">{event.occurredAt.slice(11, 19)}</p><p className="truncate text-xs text-[#5d758b]">{event.kind.replaceAll("_", " ")}</p></div><button disabled aria-label="Edit marker"><PencilIcon className="size-4 text-[#91a4b7]" /></button><button disabled aria-label="Delete marker"><Trash2Icon className="size-4 text-[#91a4b7]" /></button></div>)}{events.length === 0 && <p className="py-5 text-center text-sm text-[#71879a]">No markers.</p>}</div></section>;
}

function CameraList({ cameras, selected, siteName, search, onSearch, onToggle }: { cameras: Camera[]; selected: string[]; siteName: string; search: string; onSearch: (value: string) => void; onToggle: (id: string, checked: boolean) => void }) {
  return <section className="rounded-md border border-[#c7d8e7] bg-white p-3 shadow-sm"><h2 className="text-base font-bold">Camera List</h2><label className="relative mt-3 block"><SearchIcon className="absolute left-3 top-3 size-4 text-[#71869b]" /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search camera..." className="h-9 w-full rounded-[4px] border border-[#b9cede] bg-[#f8fbfd] pl-9 pr-3 text-xs outline-none placeholder:text-[#8094a8] focus:border-[#3487f4]" /></label><div className="mt-3"><p className="flex items-center gap-2 text-xs font-semibold text-[#425970]"><ChevronDownIcon className="size-4" /><VideoIcon className="size-4" />{siteName} ({cameras.length})</p><div className="mt-2 space-y-1">{cameras.map((camera) => { const checked = selected.includes(camera.id); return <label key={camera.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs text-[#40566b] hover:bg-[#edf5fb]"><input type="checkbox" checked={checked} onChange={(event) => onToggle(camera.id, event.target.checked)} className="size-4 accent-[#3487f4]" /><span className="min-w-0 flex-1 truncate">{camera.name}</span><span className={cn("size-2 rounded-full", camera.status === "DEAD" ? "bg-[#aab7c5]" : "bg-[#17bb67]")} /></label>; })}</div><p className="mt-4 flex items-center gap-2 text-xs font-semibold text-[#61758a]"><ChevronRightIcon className="size-4" /><VideoIcon className="size-4" />Integrated Cameras</p><p className="mt-3 flex items-center gap-2 text-xs font-semibold text-[#61758a]"><ChevronRightIcon className="size-4" /><VideoIcon className="size-4" />Mobile Units</p></div></section>;
}

/** PTZ stays disabled until a movable camera receives a backend capability and command endpoint. */
function PtzPanel({ camera }: { camera: Camera | null }) {
  return <section aria-disabled="true" className="rounded-md border border-[#c7d8e7] bg-white p-3 shadow-sm"><div className="flex items-center gap-2"><h2 className="flex-1 text-base font-bold">PTZ Control</h2><button disabled className="flex items-center gap-5 rounded-[4px] border border-[#c5d5e3] bg-[#f4f8fb] px-3 py-1.5 text-xs text-[#687d91]">{camera?.id ?? "Select camera"}<ChevronDownIcon className="size-4" /></button></div><p className="mt-1 text-xs text-[#71869a]">Disabled until this feed is configured as movable.</p><div className="mt-4 flex items-center justify-center gap-6"><div className="grid size-36 grid-cols-3 grid-rows-3 place-items-center rounded-full border border-[#b8cede] bg-[#f4f8fb] p-3"><span /><PtzButton icon={ChevronUpIcon} label="Tilt up" /><span /><PtzButton icon={ChevronLeftIcon} label="Pan left" /><span className="size-10 rounded-full bg-gradient-to-br from-[#91b8e5] to-[#47749f] shadow-[0_2px_5px_rgba(54,105,152,.4)]" /><PtzButton icon={ChevronRightIcon} label="Pan right" /><span /><PtzButton icon={ChevronDownIcon} label="Tilt down" /><span /></div><div className="flex flex-col"><PtzButton icon={PlusIcon} label="Zoom in" /><span className="border-x border-[#c5d5e3] bg-[#f4f8fb] py-3 text-center text-xs font-semibold text-[#657b90]">Zoom</span><PtzButton icon={MinusIcon} label="Zoom out" /></div></div><div className="mt-3 grid grid-cols-4 gap-2">{["Focus", "Iris", "Preset", "Auto Scan"].map((label) => <button key={label} disabled className="rounded-[4px] border border-[#c5d5e3] bg-[#f4f8fb] py-2 text-xs font-medium text-[#71869a]">{label}</button>)}</div></section>;
}

function PtzButton({ icon: Icon, label }: { icon: typeof ChevronUpIcon; label: string }) {
  return <button disabled aria-label={label} className="grid size-10 place-items-center rounded-[4px] border border-[#c5d5e3] bg-white text-[#71869a]"><Icon className="size-5" /></button>;
}

function EmptyWall() {
  return <div className="grid min-h-60 place-items-center rounded-md border border-dashed border-[#b9cede] bg-white text-sm text-[#64798e]">Select one or more cameras from the camera list.</div>;
}
