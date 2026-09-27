import { NavLink, useLocation } from "react-router-dom";
import { LockIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClient } from "@/client/context";
import { canUse, enabledSections, GROUP_ORDER, type Section } from "@/features/registry";
import { cn } from "@/lib/utils";

export function AppSidebar() {
  const { config, org, role } = useClient();
  const { pathname } = useLocation();

  const sections = enabledSections(config.sections);
  // Footer sections are pinned at the bottom rather than listed in their
  // group, so they must come OUT of the grouped list -- otherwise the sidebar
  // shows the same page twice, which is what it did.
  const byGroup = GROUP_ORDER.map((group) => ({
    group,
    items: sections.filter((section) => section.group === group && !section.footer),
  })).filter(({ items }) => items.length > 0);
  const pinned = sections.filter((section) => section.footer);

  return (
    <Sidebar collapsible="icon" className="border-r border-slate-200/80 dark:border-slate-800">
      <SidebarHeader className="flex h-13 shrink-0 items-center justify-center border-b border-slate-200/80 dark:border-slate-800 px-3">
        <NavLink to="/dashboard" className="flex items-center gap-2.5 min-w-0 w-full">
          <div className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-black border-2 border-amber-400/80 shadow-xs overflow-hidden p-0.5">
            <img
              src="/assets/ibvap-logo.jpg"
              alt="IBVAP Emblem"
              className="size-full object-contain"
            />
          </div>
          <div className="flex flex-col text-left group-data-[collapsible=icon]:hidden min-w-0">
            <span className="font-black text-sm tracking-wider text-slate-900 dark:text-slate-100 uppercase leading-none">
              IBVAP
            </span>
            <span className="text-[10px] font-semibold text-slate-600 dark:text-slate-300 leading-tight mt-0.5 truncate">
              Border Video Analytics
            </span>
            <span className="text-[9px] text-slate-400 dark:text-slate-400 leading-tight truncate">
              सीमा सुरक्षा बल &bull; BSF
            </span>
          </div>
        </NavLink>
      </SidebarHeader>

      <SidebarContent className="scrollbar-none pt-2">
        {byGroup.map(({ group, items }) => (
          <SidebarGroup key={group} className="py-1">
            <SidebarGroupLabel className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              {group}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((section) => (
                  <SidebarItem
                    key={section.id}
                    section={section}
                    active={pathname === section.path}
                    locked={!canUse(section, role)}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

      </SidebarContent>

      <SidebarFooter className="border-t border-slate-100 dark:border-slate-800/80 p-2 flex flex-col gap-1.5">
        {/* Vertical Border Watchtower Graphic & Patriotic Motto from Image 1 & 2 */}
        <div className="px-1 py-1 group-data-[collapsible=icon]:hidden">
          <div className="relative overflow-hidden rounded-xl border border-slate-200/80 dark:border-slate-800 bg-gradient-to-b from-sky-50/50 via-slate-50/60 to-emerald-50/30 dark:from-slate-900 dark:via-slate-900/80 dark:to-slate-950 p-2.5 shadow-2xs">
            {/* Background watchtower mountain image */}
            <div className="absolute inset-0 opacity-25 pointer-events-none mix-blend-multiply dark:mix-blend-screen overflow-hidden">
              <img
                src="/assets/sidebar-art.png"
                alt="Border Watchtower Artwork"
                className="w-full h-full object-cover object-left-bottom"
              />
            </div>

            {/* Slogan Text from Image 1 */}
            <div className="relative z-10 flex flex-col items-start text-left">
              <span className="text-[10px] font-black tracking-wider text-slate-700 dark:text-slate-200 uppercase leading-tight">
                VIGILANT
              </span>
              <span className="text-[10px] font-black tracking-wider text-slate-700 dark:text-slate-200 uppercase leading-tight">
                SECURE
              </span>
              <span className="text-[10px] font-black tracking-wider text-blue-700 dark:text-blue-400 uppercase leading-tight">
                STRONGER INDIA
              </span>

              {/* Indian Tricolor Bar */}
              <div className="mt-1 flex h-1 w-14 overflow-hidden rounded-full shadow-2xs">
                <div className="w-1/3 bg-[#ff9933]"></div>
                <div className="w-1/3 bg-white border-y border-slate-200"></div>
                <div className="w-1/3 bg-[#138808]"></div>
              </div>
            </div>
          </div>
        </div>

        {/* Pinned at the bottom, from the registry rather than hand-written.
            This used to be a hardcoded link to `/profile` -- a path with no
            route in the app, so it had always gone nowhere. Driving it from
            the same list as every other page is what stops that recurring. */}
        {pinned.length > 0 && (
          <SidebarMenu>
            {pinned.map((section) => (
              <SidebarItem
                key={section.id}
                section={section}
                active={pathname === section.path}
                locked={!canUse(section, role)}
              />
            ))}
          </SidebarMenu>
        )}

        <div className="truncate px-2 py-0.5 text-[10px] font-mono text-slate-400 group-data-[collapsible=icon]:hidden">
          {org ? `${org.name} · ${org.code}` : "No organisation"}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function SidebarItem({
  section,
  active,
  locked,
}: {
  section: Section;
  active: boolean;
  locked: boolean;
}) {
  const Icon = section.icon;

  const button = (
    <SidebarMenuButton
      asChild
      isActive={active}
      tooltip={section.label}
      className={cn(
        "rounded-lg font-medium text-xs transition-colors",
        active
          ? "bg-blue-600 text-white font-bold hover:bg-blue-700 hover:text-white dark:bg-blue-600 dark:text-white"
          : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
      )}
    >
      <NavLink to={section.path}>
        <Icon className={cn("size-4", active && "text-white")} />
        <span className={locked ? "text-muted-foreground" : undefined}>{section.label}</span>
      </NavLink>
    </SidebarMenuButton>
  );

  return (
    <SidebarMenuItem>
      {button}
      {locked ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarMenuBadge>
              <LockIcon className="size-3 text-muted-foreground" />
            </SidebarMenuBadge>
          </TooltipTrigger>
          <TooltipContent>Requires {section.minRole}</TooltipContent>
        </Tooltip>
      ) : null}
    </SidebarMenuItem>
  );
}
