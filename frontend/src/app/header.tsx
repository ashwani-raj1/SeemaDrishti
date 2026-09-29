import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  SunIcon,
  MoonIcon,
  BellIcon,
  ChevronDownIcon,
  UserCogIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useClient, useZones } from "@/client/context";
import { useConsoleStore } from "@/client/console-store";

/**
 * The zone filter.
 *
 * This used to be a hardcoded list of six BOPs -- Attari, Hussainiwala, Uri,
 * Poonch, Rajouri, Abohar -- labelled "Zone". Three things were wrong with it
 * and they compounded:
 *
 *   1. They were POSTS, not zones. A zone is a shape drawn on one camera's
 *      picture; a BOP is a site. The console already overloads "sector", and
 *      this made a third word mean two things.
 *   2. The node serves exactly ONE site (`/api/config` returns `site`, and the
 *      seed creates one), so five of the six named nothing that exists.
 *   3. `selectedZone` was read nowhere outside this file. Choosing one changed
 *      a label and a tick mark. No request carried it, no screen filtered on
 *      it.
 *
 * It now lists the zones the node actually has, and the choice is kept in
 * `client/console-store.ts` so it survives a refresh. Screens read it from
 * there -- the zones screen does today; anything else that should honour it
 * reads `zoneFilter` and filters on the id.
 *
 * Deliberately a ZONE ID, not a name: names are editable, and a filter that
 * silently stops matching because somebody renamed a zone is a filter that
 * lies about what it is showing.
 */
const ALL_ZONES = "__all__";

export function CommandHeader() {
  const { theme, setTheme } = useTheme();
  const { config, site, cameras, actor, users, chooseActor } = useClient();
  const navigate = useNavigate();

  // The zones the node actually has, and the filter this seat last chose.
  // Both outlive a refresh; neither is invented here.
  const zones = useZones();
  const zoneFilter = useConsoleStore((state) => state.zoneFilter);
  const setZoneFilter = useConsoleStore((state) => state.setZoneFilter);

  // Real-time live clock
  const [currentTime, setCurrentTime] = useState("");
  const [currentDate, setCurrentDate] = useState("");

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      // Format: 22:30:34
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const seconds = String(now.getSeconds()).padStart(2, "0");
      setCurrentTime(`${hours}:${minutes}:${seconds}`);

      // Format: Mon, 08 Sept 2026
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"
      ];
      const dayName = days[now.getDay()];
      const dayNum = String(now.getDate()).padStart(2, "0");
      const monthName = months[now.getMonth()];
      const year = now.getFullYear();
      setCurrentDate(`${dayName}, ${dayNum} ${monthName} ${year}`);
    };

    updateClock();
    const timer = setInterval(updateClock, 1000);
    return () => clearInterval(timer);
  }, []);

  // Deduplicated: `useZones()` flattens every camera's zones, so a zone
  // watched by three cameras arrives three times.
  const zoneOptions = Array.from(
    new Map(zones.filter((zone) => zone.active).map((zone) => [zone.id, zone])).values(),
  ).sort((a, b) => a.name.localeCompare(b.name));

  // A remembered id can name a zone that has since been deleted. Falling back
  // to "all zones" is the honest reading -- showing its stale name would claim
  // the console is filtered to something that no longer exists.
  const selected = zoneOptions.find((zone) => zone.id === zoneFilter) ?? null;
  const selectedLabel = selected?.name ?? "All zones";

  return (
    <header className="relative sticky top-0 z-20 flex h-13 w-full shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-slate-200/90 bg-white px-2.5 dark:border-slate-800 dark:bg-[#14130d] sm:px-4">
      {/* Top Navbar Background Banner Image */}
      <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden">
        <img
          src="/assets/banner-art.png"
          alt="Border Surveillance Panorama"
          className="w-full h-full object-cover object-[center_38%] opacity-80 dark:opacity-35 dark:mix-blend-luminosity select-none"
        />
        {/* Soft overlay gradients for crisp control and text readability in both modes */}
        <div className="absolute inset-0 bg-gradient-to-r from-white/75 via-white/30 to-white/50 dark:from-[#12110c]/85 dark:via-[#161510]/55 dark:to-[#12110c]/70 pointer-events-none"></div>
      </div>

      {/* LEFT: Sidebar toggle + Sector Details dynamically updating with selected Zone */}
      <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2 sm:gap-3 lg:flex-none">
        <SidebarTrigger className="-ml-1 text-slate-600 dark:text-slate-300 hover:text-slate-900" />

        {/* Sector Name & Operational Posture */}
        <div className="flex min-w-0 flex-col text-left">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-200">
            {/* The post this console is the face of, from `/api/config`.
                It was a field on the fake zone list, so it changed when the
                dropdown changed -- a console that appeared to move between
                posts it had never been connected to. */}
            <span className="truncate">{site?.name ?? config.brand.name}</span>
            {config.brand.subSector && (
              <>
                <span className="text-slate-400 font-normal">|</span>
                <span className="hidden shrink-0 font-semibold text-blue-600 dark:text-blue-400 sm:inline">
                  {config.brand.subSector}
                </span>
              </>
            )}
          </div>
          <span className="hidden truncate text-[10px] font-medium text-slate-500 dark:text-slate-400 lg:block">
            {config.brand.tagline}
          </span>
        </div>
      </div>

      {/* CENTER: Zone Filter + Live Badge (Hidden on very small screens) */}
      <div className="relative z-10 hidden items-center gap-3 lg:flex">
        {/* Zone Dropdown with increased width */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-48 flex-col items-start rounded-md border border-slate-200 bg-slate-50/80 px-3.5 py-1 shadow-2xs transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/60 dark:hover:bg-slate-800 xl:w-64">
              <span className="text-[9px] uppercase font-semibold text-slate-400 leading-none">
                Zone
              </span>
              <div className="flex w-full items-center justify-between gap-2 text-xs font-bold text-slate-800 dark:text-slate-100 mt-0.5">
                <span className="truncate">{selectedLabel}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 text-slate-400" />
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 sm:w-64">
            <DropdownMenuLabel className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Monitoring zones
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setZoneFilter(null)}
              className={`flex items-center justify-between py-1.5 cursor-pointer ${
                zoneFilter === null
                  ? "bg-blue-50 font-bold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                  : ""
              }`}
            >
              <span>All zones</span>
            </DropdownMenuItem>
            {zoneOptions.length === 0 && (
              <DropdownMenuItem disabled className="py-1.5">
                <span className="text-slate-400">No zones yet</span>
              </DropdownMenuItem>
            )}
            {zoneOptions.map((zone) => (
              <DropdownMenuItem
                key={zone.id}
                onSelect={() => setZoneFilter(zone.id)}
                className={`flex items-center justify-between py-1.5 cursor-pointer ${
                  zoneFilter === zone.id
                    ? "bg-blue-50 font-bold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                    : ""
                }`}
              >
                <span className="truncate">{zone.name}</span>
                <span className="text-[10px] font-mono text-slate-400">
                  {zone.kind}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Live Indicator Badge */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 dark:bg-emerald-950/60 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 text-xs font-bold shadow-2xs">
          <span className="size-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span>Live</span>
        </div>
      </div>

      {/* RIGHT: Theme Toggle + Bell + Digital Clock + Actor */}
      <div className="relative z-10 flex shrink-0 items-center gap-1.5 sm:gap-2 xl:gap-3.5">
        {/* Theme Switcher Button (Sun / Moon) */}
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="flex size-8 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
          title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
        >
          {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
        </button>

        {/* Notifications Bell with unread badge count */}
        <button
          onClick={() => navigate("/incidents")}
          className="relative flex size-8 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
          title="Recent Alerts & Incidents"
        >
          <BellIcon className="size-4" />
          <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white shadow-xs">
            3
          </span>
        </button>

        {/* Digital Real-Time Clock */}
        <div className="hidden flex-col items-end pl-1 pr-1.5 xl:flex">
          <span className="font-mono text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 tracking-wider">
            {currentTime || "22:30:34"}
          </span>
          <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
            {currentDate || "Mon, 08 Sept 2026"}
          </span>
        </div>

        {/* Operator Switcher Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 px-2 text-xs">
              <UserCogIcon className="size-3.5 mr-1" />
              <span className="hidden font-medium xl:inline">{actor?.name ?? "Operator"}</span>
              <Badge variant="secondary" className="px-1 py-0 font-mono text-[10px] xl:ml-1">
                {actor?.role ?? "op"}
              </Badge>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Duty Operator Profile</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {users.map((user) => (
                <DropdownMenuItem key={user.id} onSelect={() => chooseActor(user.id)}>
                  <span className="flex-1 font-medium">{user.name}</span>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {user.role}
                  </Badge>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
