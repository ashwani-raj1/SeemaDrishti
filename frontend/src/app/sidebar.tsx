import { NavLink, useLocation } from "react-router-dom";
import { LockIcon, RadioTowerIcon } from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClient } from "@/client/context";
import { canUse, enabledSections, GROUP_ORDER, type Section } from "@/features/registry";

/**
 * Sections this deployment runs, grouped.
 *
 * A section the current role may not use is shown locked rather than hidden:
 * the platform is the same everywhere, and an operator being able to see that
 * history search exists -- and that a supervisor holds it -- is more honest
 * than a nav bar that silently changes shape per person.
 */
export function AppSidebar() {
  const { config, org, site, role } = useClient();
  const { pathname } = useLocation();

  const sections = enabledSections(config.sections);
  const byGroup = GROUP_ORDER.map((group) => ({
    group,
    items: sections.filter((section) => section.group === group),
  })).filter(({ items }) => items.length > 0);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/incidents">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <RadioTowerIcon className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">{config.brand.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {site?.name ?? config.brand.tagline}
                  </span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {byGroup.map(({ group, items }) => (
          <SidebarGroup key={group}>
            <SidebarGroupLabel>{group}</SidebarGroupLabel>
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

      <SidebarFooter>
        <div className="truncate px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
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
    <SidebarMenuButton asChild isActive={active} tooltip={section.label}>
      <NavLink to={section.path}>
        <Icon />
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
      ) : (
        !section.backed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarMenuBadge className="text-muted-foreground">·</SidebarMenuBadge>
            </TooltipTrigger>
            <TooltipContent>Defined in the design, no endpoint yet</TooltipContent>
          </Tooltip>
        )
      )}
    </SidebarMenuItem>
  );
}
