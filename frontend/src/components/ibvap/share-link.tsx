import { useEffect, useState } from "react";
import { CheckIcon, LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Copy this page's address.
 *
 * The reason detail lives at its own URL rather than in a drawer: a shift
 * handover is somebody saying "look at this one", and that has to survive
 * being pasted into a message. A drawer has no address to paste.
 */
export function ShareLink({ label = "Copy link" }: { label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied", { description: url });
    } catch {
      // A post's browser may be locked down, or the page served over plain
      // HTTP where the clipboard API is unavailable. Show the address so it
      // can still be copied by hand rather than failing silently.
      toast.error("Could not reach the clipboard", { description: url });
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={copy}>
      {copied ? <CheckIcon className="size-4" /> : <LinkIcon className="size-4" />}
      {copied ? "Copied" : label}
    </Button>
  );
}
