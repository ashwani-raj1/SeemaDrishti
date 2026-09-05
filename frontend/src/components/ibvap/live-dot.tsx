import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClient } from "@/client/context";
import { cn } from "@/lib/utils";

const LABEL = {
  live: "Live — receiving push from the edge node",
  connecting: "Connecting to the edge node…",
  down: "No live push. The screen may be stale — reload to reconnect.",
} as const;

/**
 * Whether the live push is actually alive.
 *
 * The documented failure of existing systems is silent capability loss. A dead
 * stream looks exactly like a quiet night, so it gets said out loud here for
 * the same reason a blind camera does.
 */
export function LiveDot({ withLabel = false }: { withLabel?: boolean }) {
  const { stream } = useClient();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative flex size-2">
            {stream === "live" && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            )}
            <span
              className={cn(
                "relative inline-flex size-2 rounded-full",
                stream === "live" && "bg-emerald-500",
                stream === "connecting" && "bg-amber-500",
                stream === "down" && "bg-destructive",
              )}
            />
          </span>
          {withLabel && <span className="font-mono uppercase">{stream}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent>{LABEL[stream]}</TooltipContent>
    </Tooltip>
  );
}
