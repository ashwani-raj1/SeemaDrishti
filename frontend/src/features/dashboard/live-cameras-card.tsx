import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  VideoIcon,
  Maximize2Icon,
  Volume2Icon,
  VolumeXIcon,
  ArrowRightIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Camera } from "@/lib/types";

interface LiveCamerasCardProps {
  cameras: Camera[];
  selectedCameraId?: string | null;
  onSelectCamera?: (id: string) => void;
  whepBase?: string;
  className?: string;
}

interface SingleCameraTileProps {
  id: string;
  code: string;
  name: string;
  timestamp: string;
  type: "fence" | "vehicle";
  whepBase?: string;
  streamPath?: string;
}

function SingleCameraTile({
  code,
  name,
  timestamp,
  type,
}: SingleCameraTileProps) {
  const [isMuted, setIsMuted] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Dynamic night vision CCTV canvas animation with scanlines and motion tracking
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let frame = 0;

    const render = () => {
      frame++;
      const w = canvas.width;
      const h = canvas.height;

      // Dark warm night-vision background
      ctx.fillStyle = "#0c0b08";
      ctx.fillRect(0, 0, w, h);

      // Night lighting vignette
      const grad = ctx.createRadialGradient(w / 2, h * 0.4, 30, w / 2, h * 0.5, w * 0.7);
      grad.addColorStop(0, "rgba(225, 215, 185, 0.18)");
      grad.addColorStop(0.5, "rgba(120, 115, 95, 0.10)");
      grad.addColorStop(1, "rgba(8, 7, 5, 0.88)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Draw landscape based on camera type
      if (type === "fence") {
        // Perspective Fence Line with floodlights
        ctx.strokeStyle = "rgba(195, 185, 160, 0.35)";
        ctx.lineWidth = 1.5;

        // Ground perspective lines
        for (let i = -4; i <= 4; i++) {
          ctx.beginPath();
          ctx.moveTo(w * 0.5 + i * 25, h * 0.35);
          ctx.lineTo(w * 0.5 + i * 140, h);
          ctx.stroke();
        }

        // Fence posts
        for (let i = 1; i <= 6; i++) {
          const postX = w * 0.78 - i * 18;
          const postY = h * 0.35 + i * 28;
          const postH = 45 + i * 8;
          ctx.strokeStyle = "rgba(190, 180, 155, 0.4)";
          ctx.beginPath();
          ctx.moveTo(postX, postY);
          ctx.lineTo(postX, postY - postH);
          ctx.stroke();

          // Floodlight on post
          ctx.fillStyle = "rgba(255, 240, 190, 0.85)";
          ctx.beginPath();
          ctx.arc(postX, postY - postH, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Horizontal wires
        ctx.strokeStyle = "rgba(175, 165, 140, 0.25)";
        for (let offset = 10; offset <= 40; offset += 10) {
          ctx.beginPath();
          ctx.moveTo(w * 0.2, h * 0.35 - offset);
          ctx.lineTo(w * 0.8, h * 0.7 - offset);
          ctx.stroke();
        }

        // Person detection in sector
        const boxX = w * 0.58;
        const boxY = h * 0.42;
        const boxW = 28;
        const boxH = 58;

        // Bounding box
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(boxX, boxY, boxW, boxH);

        // Person stick figure / silhouette
        ctx.fillStyle = "rgba(239, 68, 68, 0.15)";
        ctx.fillRect(boxX, boxY, boxW, boxH);

        // Head
        ctx.fillStyle = "#ef4444";
        ctx.beginPath();
        ctx.arc(boxX + boxW / 2, boxY + 10, 4.5, 0, Math.PI * 2);
        ctx.fill();

        // Torso & legs
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(boxX + boxW / 2, boxY + 15);
        ctx.lineTo(boxX + boxW / 2, boxY + 36);
        ctx.lineTo(boxX + 6, boxY + 54);
        ctx.moveTo(boxX + boxW / 2, boxY + 36);
        ctx.lineTo(boxX + boxW - 6, boxY + 54);
        ctx.stroke();

        // Label tag
        ctx.fillStyle = "#ef4444";
        ctx.fillRect(boxX, boxY - 14, 46, 13);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 8.5px monospace";
        ctx.fillText("PERSON 94%", boxX + 2, boxY - 4);
      } else {
        // Road perspective
        ctx.fillStyle = "#13120d";
        ctx.beginPath();
        ctx.moveTo(w * 0.48, h * 0.35);
        ctx.lineTo(w * 0.52, h * 0.35);
        ctx.lineTo(w * 0.75, h);
        ctx.lineTo(w * 0.25, h);
        ctx.closePath();
        ctx.fill();

        // Road center dashed line
        ctx.strokeStyle = "rgba(215, 210, 190, 0.3)";
        ctx.lineWidth = 2;
        ctx.setLineDash([12, 16]);
        ctx.beginPath();
        ctx.moveTo(w * 0.5, h * 0.35);
        ctx.lineTo(w * 0.5, h);
        ctx.stroke();
        ctx.setLineDash([]);

        // Fence on both sides
        ctx.strokeStyle = "rgba(175, 165, 145, 0.4)";
        ctx.lineWidth = 1.5;
        for (let x of [w * 0.08, w * 0.92]) {
          for (let y = h * 0.35; y < h; y += 30) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y - 50);
            ctx.stroke();
          }
        }

        // Patrol vehicle in center
        const carX = w * 0.44;
        const carY = h * 0.56;
        const carW = 60;
        const carH = 44;

        // Vehicle body silhouette
        ctx.fillStyle = "#27251d";
        ctx.fillRect(carX, carY, carW, carH);
        ctx.fillStyle = "#1b1913";
        ctx.fillRect(carX + 6, carY - 18, carW - 12, 20);

        // Headlights glow
        ctx.fillStyle = "rgba(255, 255, 230, 0.85)";
        ctx.beginPath();
        ctx.arc(carX + 12, carY + 16, 5, 0, Math.PI * 2);
        ctx.arc(carX + carW - 12, carY + 16, 5, 0, Math.PI * 2);
        ctx.fill();

        // Headlight beams onto road
        const beamGrad = ctx.createLinearGradient(0, carY + 20, 0, h);
        beamGrad.addColorStop(0, "rgba(255, 255, 220, 0.35)");
        beamGrad.addColorStop(1, "rgba(255, 255, 220, 0)");
        ctx.fillStyle = beamGrad;
        ctx.beginPath();
        ctx.moveTo(carX + 10, carY + 20);
        ctx.lineTo(w * 0.25, h);
        ctx.lineTo(w * 0.75, h);
        ctx.lineTo(carX + carW - 10, carY + 20);
        ctx.closePath();
        ctx.fill();

        // Vehicle detection bounding box
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(carX - 4, carY - 20, carW + 8, carH + 24);

        ctx.fillStyle = "#f59e0b";
        ctx.fillRect(carX - 4, carY - 34, 68, 13);
        ctx.fillStyle = "#000000";
        ctx.font = "bold 8.5px monospace";
        ctx.fillText("VEHICLE 98%", carX - 1, carY - 24);
      }

      // Scanline effect
      ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
      for (let y = 0; y < h; y += 3) {
        ctx.fillRect(0, y, w, 1);
      }

      // CCTV noise grain
      ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
      for (let i = 0; i < 40; i++) {
        const rx = Math.random() * w;
        const ry = Math.random() * h;
        ctx.fillRect(rx, ry, 2, 2);
      }

      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [type]);

  return (
    <div
      className={cn(
        "group relative flex-1 min-h-0 flex flex-col rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 overflow-hidden shadow-xs",
        isExpanded && "fixed inset-8 z-50 shadow-2xl"
      )}
    >
      {/* Top Overlay Bar */}
      <div className="flex items-center justify-between px-2.5 py-1 bg-slate-900/95 text-white border-b border-slate-800 text-xs font-medium z-10 shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-100 text-[11px]">{code}</span>
          <span className="text-[10px] text-slate-400 font-normal truncate">{name}</span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Live indicator badge */}
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-800 text-emerald-400 text-[9px] font-medium">
            <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Live</span>
          </div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-slate-400 hover:text-white transition-colors"
            title="Expand feed"
          >
            <Maximize2Icon className="size-3" />
          </button>
        </div>
      </div>

      {/* Video / Canvas Viewport */}
      <div className="relative flex-1 min-h-0 w-full overflow-hidden bg-slate-950">
        <canvas
          ref={canvasRef}
          width={480}
          height={270}
          className="size-full object-cover"
        />

        {/* Timestamp Bottom Left HUD */}
        <div className="absolute bottom-2 left-2.5 font-mono text-[11px] font-semibold text-slate-200 drop-shadow-md tracking-wider">
          {timestamp}
        </div>

        {/* Audio & Fullscreen Buttons Bottom Right */}
        <div className="absolute bottom-2 right-2.5 flex items-center gap-2">
          <button
            onClick={() => setIsMuted(!isMuted)}
            className="flex size-6 items-center justify-center rounded-sm bg-black/60 text-slate-300 hover:text-white hover:bg-black/80 transition-colors backdrop-blur-xs"
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <VolumeXIcon className="size-3.5" /> : <Volume2Icon className="size-3.5" />}
          </button>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex size-6 items-center justify-center rounded-sm bg-black/60 text-slate-300 hover:text-white hover:bg-black/80 transition-colors backdrop-blur-xs"
            title="Fullscreen"
          >
            <Maximize2Icon className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function LiveCamerasCard({
  cameras,
  selectedCameraId,
  onSelectCamera,
  whepBase,
  className,
}: LiveCamerasCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden h-full",
        className
      )}
    >
      {/* Card Header */}
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-slate-100 dark:border-slate-800/80 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
            <VideoIcon className="size-3.5" />
          </div>
          <div>
            <h2 className="text-xs font-bold tracking-tight text-slate-800 dark:text-slate-100 leading-tight">
              Live Cameras
            </h2>
          </div>
        </div>

        <Link
          to="/live"
          className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 transition-colors"
        >
          <span>View All</span>
          <ArrowRightIcon className="size-3" />
        </Link>
      </div>

      {/* Camera Feed Cards Container */}
      <div className="flex-1 min-h-0 p-2.5 flex flex-col gap-2 justify-between overflow-hidden">
        <SingleCameraTile
          id="cam_fence_north"
          code="CAM-01"
          name="Fence North &bull; Sector 2A"
          timestamp="08-09-2026 22:30:34"
          type="fence"
          whepBase={whepBase}
        />

        <SingleCameraTile
          id="cam_patrol_road"
          code="CAM-05"
          name="Patrol Road &bull; Sector 2C"
          timestamp="08-09-2026 22:28:17"
          type="vehicle"
          whepBase={whepBase}
        />
      </div>
    </div>
  );
}
