import { useState } from "react";
import {
  LayoutGridIcon,
  UsersIcon,
  CarIcon,
  CreditCardIcon,
  GitCommitIcon,
  ClockIcon,
  ActivityIcon,
  PackageIcon,
  CalendarIcon,
  ChevronDownIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type DetectionCategory =
  | "all"
  | "people"
  | "vehicles"
  | "plates"
  | "fence"
  | "loitering"
  | "crawling"
  | "objects";

interface DetectionFilterBarProps {
  selectedCategory: DetectionCategory;
  onSelectCategory: (cat: DetectionCategory) => void;
  timeRange: string;
  onSelectTimeRange: (range: string) => void;
  className?: string;
}

const CATEGORIES: { id: DetectionCategory; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "all", label: "All", icon: LayoutGridIcon },
  { id: "people", label: "People", icon: UsersIcon },
  { id: "vehicles", label: "Vehicles", icon: CarIcon },
  { id: "plates", label: "Number Plates", icon: CreditCardIcon },
  { id: "fence", label: "Fence Crossing", icon: GitCommitIcon },
  { id: "loitering", label: "Loitering", icon: ClockIcon },
  { id: "crawling", label: "Crawling", icon: ActivityIcon },
  { id: "objects", label: "Objects", icon: PackageIcon },
];

export function DetectionFilterBar({
  selectedCategory,
  onSelectCategory,
  timeRange,
  onSelectTimeRange,
  className,
}: DetectionFilterBarProps) {
  const [timeDropdownOpen, setTimeDropdownOpen] = useState(false);

  const timeOptions = ["Last 1 Hour", "Last 12 Hours", "Last 24 Hours", "Last 7 Days"];

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs",
        className
      )}
    >
      {/* Left: Label and Filter Chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-bold text-xs tracking-tight text-slate-800 dark:text-slate-100 mr-1 whitespace-nowrap">
          Show Detections
        </span>

        <div className="flex flex-wrap items-center gap-1">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isSelected = selectedCategory === cat.id;

            return (
              <button
                key={cat.id}
                onClick={() => onSelectCategory(cat.id)}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all whitespace-nowrap",
                  isSelected
                    ? "bg-blue-600 text-white shadow-xs"
                    : "bg-slate-50 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60"
                )}
              >
                <Icon className={cn("size-3", isSelected ? "text-white" : "text-slate-500 dark:text-slate-400")} />
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: Time Range Selector */}
      <div className="relative">
        <button
          onClick={() => setTimeDropdownOpen(!timeDropdownOpen)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          <CalendarIcon className="size-3.5 text-slate-500 dark:text-slate-400" />
          <span>{timeRange}</span>
          <ChevronDownIcon className="size-3.5 text-slate-400" />
        </button>

        {timeDropdownOpen && (
          <div className="absolute right-0 top-full mt-1.5 w-36 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1 z-30">
            {timeOptions.map((opt) => (
              <button
                key={opt}
                onClick={() => {
                  onSelectTimeRange(opt);
                  setTimeDropdownOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-xs font-medium transition-colors hover:bg-slate-100 dark:hover:bg-slate-800",
                  timeRange === opt ? "font-bold text-blue-600 dark:text-blue-400" : "text-slate-700 dark:text-slate-300"
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
