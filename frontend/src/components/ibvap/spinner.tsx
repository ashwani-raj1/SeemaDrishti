import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Button has no isPending prop; compose with this + disabled. */
export function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>) {
  return <Loader2Icon className={cn("animate-spin", className)} {...props} />;
}
