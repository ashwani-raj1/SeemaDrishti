import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api, needsReason } from "@/lib/api";
import type { Decision, Incident } from "@/lib/types";

/**
 * Acting on an incident, from anywhere that lists one.
 *
 * Extracted so a service page does not reimplement the escalate/dismiss rules
 * slightly differently from the incidents queue. There is exactly one rule and
 * it is the node's: escalate and dismiss carry a stated reason, enforced with a
 * 422. A screen that forgot to prompt would produce an action the node rejects
 * and an operator who thinks they dismissed something they did not.
 *
 * Acknowledge is deliberately immediate -- it is the "I have seen this" verb,
 * and making it cost a dialog is how a queue stops getting acknowledged.
 */
export function useDecide(onUpdated: (incident: Incident) => void) {
  const [prompt, setPrompt] = useState<{ decision: Decision; incident: Incident } | null>(null);
  const [pending, setPending] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);

  const decide = useCallback(
    async (incident: Incident, decision: Decision, reason?: string) => {
      setPending(true);
      try {
        onUpdated(await api.decide(incident.id, decision, reason));
        toast.success(`Incident ${decision}d`, { description: incident.title });
        setPrompt(null);
        setReasonError(null);
      } catch (cause) {
        // The node says "a reason is required" with a 422. Open the dialog
        // rather than swallowing it into a generic failure toast.
        if (needsReason(cause)) {
          setReasonError((cause as Error).message);
          setPrompt({ decision, incident });
        } else {
          toast.error((cause as Error).message);
        }
      } finally {
        setPending(false);
      }
    },
    [onUpdated],
  );

  const act = useCallback(
    (incident: Incident, decision: Decision) => {
      if (decision === "acknowledge") void decide(incident, decision);
      else setPrompt({ decision, incident });
    },
    [decide],
  );

  return { prompt, setPrompt, pending, reasonError, decide, act };
}
