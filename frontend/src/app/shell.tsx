import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { UserCogIcon } from "lucide-react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";
import { useClient } from "@/client/context";
import { canUse, DEFAULT_PATH, enabledSections } from "@/features/registry";
import { LiveDot } from "@/components/ibvap/live-dot";
import { RoleGate } from "@/components/ibvap/states";
import { AppSidebar } from "./sidebar";
import { CommandHeader } from "./header";

export function AppShell() {
  return (
    <TooltipProvider delayDuration={200}>
      <SidebarProvider>
        <ShellLayout />
      </SidebarProvider>
      <Toaster position="top-right" />
    </TooltipProvider>
  );
}

/** The analytics landing screen is deliberately a full-width workspace. */
function ShellLayout() {
  const { pathname } = useLocation();
  const analyticsWorkspace = pathname === "/cameras";
  const content = <><CommandHeader /><div className="flex-1 min-h-0 overflow-hidden flex flex-col"><Outlet /></div></>;

  if (analyticsWorkspace) return <div className="h-screen overflow-hidden flex flex-col">{content}</div>;
  return <><AppSidebar /><SidebarInset className="h-screen overflow-hidden flex flex-col">{content}</SidebarInset></>;
}

function Header() {
  const { config, actor, users, chooseActor, site } = useClient();
  const { pathname } = useLocation();
  const current = enabledSections(config.sections).find((section) => section.path === pathname);

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <span className="truncate text-sm font-medium">{current?.label ?? config.brand.name}</span>
      {site && (
        <Badge variant="secondary" className="hidden font-mono text-xs sm:inline-flex">
          {site.name}
        </Badge>
      )}

      <div className="ml-auto flex items-center gap-3">
        <LiveDot withLabel />
        <ActorSwitcher actor={actor} users={users} onChoose={chooseActor} />
      </div>
    </header>
  );
}

/**
 * ponytail: the node identifies the caller by the x-ibvap-actor header and
 * records whatever it is told, so this stands in for a login. What matters for
 * this slice is that no write path is anonymous -- swap for real local auth
 * when #34 gets a backend. It also happens to be how role-scoped views are
 * demonstrated.
 */
function ActorSwitcher({
  actor,
  users,
  onChoose,
}: {
  actor: ReturnType<typeof useClient>["actor"];
  users: ReturnType<typeof useClient>["users"];
  onChoose: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <UserCogIcon data-icon="inline-start" />
          <span className="hidden sm:inline">{actor?.name ?? "No actor"}</span>
          <Badge variant="secondary" className="ml-1 font-mono text-xs">
            {actor?.role ?? "—"}
          </Badge>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Acting as</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {users.map((user) => (
            <DropdownMenuItem key={user.id} onSelect={() => onChoose(user.id)}>
              <span className="flex-1">{user.name}</span>
              <Badge variant="outline" className="font-mono text-xs">
                {user.role}
              </Badge>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Stands in for a login. Every decision is recorded against this name.
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Routes are generated from the registry, so nav and routing cannot drift. */
export function AppRoutes() {
  const { config, role } = useClient();
  const sections = enabledSections(config.sections);

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to={DEFAULT_PATH} replace />} />
        {sections.flatMap((section) => {
          const guard = (element: React.ReactNode) =>
            canUse(section, role) ? element : <RoleGate need={section.minRole}>{element}</RoleGate>;

          return [
            <Route key={section.id} path={section.path} element={guard(section.element)} />,
            // Detail pages inherit their section's role gate, so a shared link
            // cannot be a way around it.
            ...(section.details ?? []).map((detail) => (
              <Route key={detail.path} path={detail.path} element={guard(detail.element)} />
            )),
          ];
        })}
        <Route path="*" element={<Navigate to={DEFAULT_PATH} replace />} />
      </Route>
    </Routes>
  );
}
