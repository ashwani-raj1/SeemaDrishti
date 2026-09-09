import { useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ClockIcon,
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  UserIcon,
  CarIcon,
  UsersIcon,
  ActivityIcon,
  PackageIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DetectionCategory } from "./detection-filter-bar";

interface RecentEventItem {
  id: string;
  category: DetectionCategory;
  title: string;
  camera: string;
  time: string;
  type: "person" | "vehicle" | "group" | "crawling" | "object";
}

interface RecentEventsCarouselProps {
  categoryFilter: DetectionCategory;
  className?: string;
}

const EVENTS_DATA: RecentEventItem[] = [
  {
    id: "evt-1",
    category: "people",
    title: "Person detected",
    camera: "CAM-01",
    time: "22:30:34",
    type: "person",
  },
  {
    id: "evt-2",
    category: "vehicles",
    title: "Vehicle detected",
    camera: "CAM-05",
    time: "22:28:17",
    type: "vehicle",
  },
  {
    id: "evt-3",
    category: "people",
    title: "Multiple people",
    camera: "CAM-02",
    time: "22:24:03",
    type: "group",
  },
  {
    id: "evt-4",
    category: "crawling",
    title: "Crawling detected",
    camera: "CAM-03",
    time: "22:19:45",
    type: "crawling",
  },
  {
    id: "evt-5",
    category: "objects",
    title: "Object detected",
    camera: "CAM-07",
    time: "22:17:31",
    type: "object",
  },
  {
    id: "evt-6",
    category: "vehicles",
    title: "Vehicle detected",
    camera: "CAM-05",
    time: "22:14:28",
    type: "vehicle",
  },
  {
    id: "evt-7",
    category: "people",
    title: "Multiple people",
    camera: "CAM-02",
    time: "22:13:02",
    type: "group",
  },
  {
    id: "evt-8",
    category: "people",
    title: "Person detected",
    camera: "CAM-01",
    time: "22:11:06",
    type: "person",
  },
];

function EventThumbnail({ type }: { type: RecentEventItem["type"] }) {
  // Renders a high-fidelity night-vision CCTV snapshot with monochrome grading and detection box
  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-md bg-slate-950 border border-slate-800">
      <svg
        viewBox="0 0 240 150"
        className="size-full object-cover select-none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id="cctvGlow" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#8c8065" stopOpacity="0.3" />
            <stop offset="60%" stopColor="#3d3728" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#0d0c08" stopOpacity="0.95" />
          </radialGradient>
        </defs>

        {/* Background Night Terrain */}
        <rect width="240" height="150" fill="#0f0e0a" />
        <rect width="240" height="150" fill="url(#cctvGlow)" />

        {/* Perimeter fence rows in background */}
        <line x1="0" y1="50" x2="240" y2="50" stroke="#423e30" strokeWidth="1" strokeDasharray="4 4" />
        <line x1="0" y1="75" x2="240" y2="75" stroke="#524d3c" strokeWidth="1" />
        <line x1="20" y1="40" x2="20" y2="95" stroke="#756f5a" strokeWidth="2" />
        <line x1="80" y1="40" x2="80" y2="105" stroke="#756f5a" strokeWidth="2.5" />
        <line x1="160" y1="40" x2="160" y2="115" stroke="#756f5a" strokeWidth="3" />
        <line x1="220" y1="40" x2="220" y2="125" stroke="#756f5a" strokeWidth="3" />

        {/* Ground texture */}
        <path d="M0 80 Q60 76 120 82 T240 85 L240 150 L0 150 Z" fill="#17150f" />

        {/* Specific Subject Rendering based on type */}
        {type === "person" && (
          <g transform="translate(100, 45)">
            {/* Person silhouette */}
            <circle cx="20" cy="15" r="7" fill="#b0c0d5" />
            <path d="M14 24 L26 24 L24 55 L26 80 L22 80 L19 58 L16 80 L12 80 L14 55 Z" fill="#9db0c6" />
            <line x1="14" y1="26" x2="7" y2="50" stroke="#9db0c6" strokeWidth="4" strokeLinecap="round" />
            <line x1="26" y1="26" x2="33" y2="50" stroke="#9db0c6" strokeWidth="4" strokeLinecap="round" />
            {/* Red Bounding Box */}
            <rect x="5" y="4" width="30" height="78" fill="none" stroke="#ef4444" strokeWidth="1.5" />
            <rect x="5" y="0" width="30" height="9" fill="#ef4444" />
            <text x="7" y="7" fill="#fff" fontSize="6" fontWeight="bold" fontFamily="monospace">
              PERSON
            </text>
          </g>
        )}

        {type === "vehicle" && (
          <g transform="translate(75, 45)">
            {/* Vehicle silhouette */}
            <rect x="15" y="28" width="60" height="42" rx="4" fill="#2c3647" />
            <path d="M22 28 L30 10 L60 10 L68 28 Z" fill="#1f2735" />
            {/* Headlights */}
            <circle cx="26" cy="46" r="6" fill="#fef08a" />
            <circle cx="64" cy="46" r="6" fill="#fef08a" />
            {/* Amber Bounding Box */}
            <rect x="10" y="8" width="70" height="66" fill="none" stroke="#f59e0b" strokeWidth="1.5" />
            <rect x="10" y="2" width="36" height="9" fill="#f59e0b" />
            <text x="12" y="9" fill="#000" fontSize="6" fontWeight="bold" fontFamily="monospace">
              VEHICLE
            </text>
          </g>
        )}

        {type === "group" && (
          <g transform="translate(80, 48)">
            {/* Person 1 */}
            <circle cx="20" cy="16" r="6" fill="#b0c0d5" />
            <path d="M15 24 L25 24 L23 52 L25 74 L21 74 L19 54 L17 74 L13 74 Z" fill="#9db0c6" />
            {/* Person 2 */}
            <circle cx="48" cy="18" r="6" fill="#98a8bd" />
            <path d="M43 26 L53 26 L51 54 L53 74 L49 74 L47 56 L45 74 L41 74 Z" fill="#8898ad" />
            {/* Bounding Box */}
            <rect x="8" y="6" width="54" height="72" fill="none" stroke="#ef4444" strokeWidth="1.5" />
            <rect x="8" y="0" width="32" height="9" fill="#ef4444" />
            <text x="10" y="7" fill="#fff" fontSize="6" fontWeight="bold" fontFamily="monospace">
              2 PEOPLE
            </text>
          </g>
        )}

        {type === "crawling" && (
          <g transform="translate(70, 70)">
            {/* Crawling figure */}
            <circle cx="30" cy="22" r="7" fill="#b0c0d5" />
            <path d="M36 24 Q60 22 75 32 Q70 42 50 36 L40 44 L32 38 Z" fill="#9db0c6" />
            <line x1="28" y1="28" x2="18" y2="40" stroke="#9db0c6" strokeWidth="4" strokeLinecap="round" />
            <line x1="72" y1="34" x2="84" y2="44" stroke="#9db0c6" strokeWidth="4" strokeLinecap="round" />
            {/* Orange Bounding Box */}
            <rect x="10" y="12" width="80" height="36" fill="none" stroke="#f97316" strokeWidth="1.5" />
            <rect x="10" y="6" width="38" height="9" fill="#f97316" />
            <text x="12" y="13" fill="#fff" fontSize="6" fontWeight="bold" fontFamily="monospace">
              CRAWLING
            </text>
          </g>
        )}

        {type === "object" && (
          <g transform="translate(90, 68)">
            {/* Unattended bag */}
            <rect x="16" y="20" width="34" height="26" rx="3" fill="#475569" />
            <path d="M26 20 L26 12 Q33 8 40 12 L40 20" fill="none" stroke="#64748b" strokeWidth="3" />
            {/* Yellow Bounding Box */}
            <rect x="10" y="8" width="46" height="42" fill="none" stroke="#eab308" strokeWidth="1.5" />
            <rect x="10" y="2" width="32" height="9" fill="#eab308" />
            <text x="12" y="9" fill="#000" fontSize="6" fontWeight="bold" fontFamily="monospace">
              OBJECT
            </text>
          </g>
        )}

        {/* Scanlines */}
        <line x1="0" y1="25" x2="240" y2="25" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="1" />
        <line x1="0" y1="65" x2="240" y2="65" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="1" />
        <line x1="0" y1="105" x2="240" y2="105" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="1" />
      </svg>
    </div>
  );
}

export function RecentEventsCarousel({
  categoryFilter,
  className,
}: RecentEventsCarouselProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const scroll = (direction: "left" | "right") => {
    if (scrollContainerRef.current) {
      const offset = direction === "left" ? -240 : 240;
      scrollContainerRef.current.scrollBy({ left: offset, behavior: "smooth" });
    }
  };

  const filteredEvents = EVENTS_DATA.filter((evt) => {
    if (categoryFilter === "all") return true;
    return evt.category === categoryFilter;
  });

  const getEventIcon = (type: RecentEventItem["type"]) => {
    switch (type) {
      case "person":
        return <UserIcon className="size-3 text-slate-500" />;
      case "vehicle":
        return <CarIcon className="size-3 text-slate-500" />;
      case "group":
        return <UsersIcon className="size-3 text-slate-500" />;
      case "crawling":
        return <ActivityIcon className="size-3 text-slate-500" />;
      case "object":
        return <PackageIcon className="size-3 text-slate-500" />;
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden h-[155px] shrink-0",
        className
      )}
    >
      {/* Card Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 dark:border-slate-800/80 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="flex size-5 items-center justify-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
            <ClockIcon className="size-3" />
          </div>
          <h2 className="text-xs font-bold tracking-tight text-slate-800 dark:text-slate-100 leading-tight">
            Recent Events
          </h2>
        </div>

        <div className="flex items-center gap-2.5">
          <Link
            to="/events"
            className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 transition-colors"
          >
            <span>View All</span>
            <ArrowRightIcon className="size-3" />
          </Link>

          {/* Carousel Arrow Buttons */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => scroll("left")}
              className="flex size-6 items-center justify-center rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors"
              title="Scroll left"
            >
              <ChevronLeftIcon className="size-3.5" />
            </button>
            <button
              onClick={() => scroll("right")}
              className="flex size-6 items-center justify-center rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors"
              title="Scroll right"
            >
              <ChevronRightIcon className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Horizontal Scrolling Filmstrip */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 flex items-stretch gap-2.5 p-2 overflow-x-auto scroll-smooth scrollbar-none"
      >
        {filteredEvents.map((evt) => (
          <div
            key={evt.id}
            onClick={() => navigate("/events")}
            className="group flex flex-col w-[145px] shrink-0 rounded-md border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden cursor-pointer hover:border-blue-500/50 hover:shadow-xs transition-all"
          >
            {/* Snapshot */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <EventThumbnail type={evt.type} />
            </div>

            {/* Event Label & Meta */}
            <div className="p-1.5 flex flex-col gap-0.5 shrink-0 bg-white dark:bg-slate-900">
              <div className="flex items-center gap-1">
                {getEventIcon(evt.type)}
                <span className="text-[11px] font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors leading-tight">
                  {evt.title}
                </span>
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 dark:text-slate-400 leading-none">
                <span>{evt.time}</span>
                <span className="font-semibold text-slate-700 dark:text-slate-300">{evt.camera}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
