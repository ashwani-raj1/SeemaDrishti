import type { LucideIcon } from "lucide-react";
import { LockIcon, PlugZapIcon, TriangleAlertIcon } from "lucide-react";
import {
  Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from "@/components/ui/empty";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/client/context";
import type { Role } from "@/lib/types";
import type { ApiError } from "@/lib/api";

export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const unreachable = error.status === 0;
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{unreachable ? "Edge node unreachable" : "Request failed"}</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function NothingHere({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}

/**
 * A section the platform defines but this build does not yet serve.
 *
 * Named honestly, with the endpoint it waits on, rather than filled with
 * plausible-looking invented data -- the same discipline the simulated sensor
 * feed gets. A screen that lies about being wired is worse than an empty one.
 */
export function NotWired({ label, item, waitingOn }: { label: string; item: string; waitingOn: string }) {
  return (
    <NothingHere
      icon={PlugZapIcon}
      title={`${label} is not wired up yet`}
      description={`Defined in the platform design as ${item}. It has no screen because the edge node serves no endpoint for it yet — so there is nothing real to show, and nothing invented is shown in its place.`}
    >
      <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
        waiting on {waitingOn}
      </code>
    </NothingHere>
  );
}

const RANK: Record<Role, number> = { operator: 0, supervisor: 1, admin: 2 };

/**
 * The node enforces this with a 403; the screen just refuses earlier and says
 * why, so an operator is not sent to a form that will reject them.
 */
export function RoleGate({ need, children }: { need: Role; children: React.ReactNode }) {
  const { role } = useClient();
  if (RANK[role] >= RANK[need]) return <>{children}</>;

  return (
    <NothingHere
      icon={LockIcon}
      title={`Requires ${need}`}
      description={`You are acting as ${role}. Switch actor in the header to view this section.`}
    />
  );
}
