import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckIcon, InboxIcon, SirenIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageShell } from "@/components/ibvap/page-shell";
import { SeverityBadge } from "@/components/ibvap/badges";
import { LoadingRows, NothingHere } from "@/components/ibvap/states";
import { ReasonDialog } from "@/components/ibvap/reason-dialog";
import { api, needsReason } from "@/lib/api";
import { clockTime, relative } from "@/lib/format";
import type { Decision, Incident } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useIncidents } from "./use-incidents";
import { IncidentSheet } from "./sheet";

const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-destructive/10 text-destructive border-destructive/30",
  ACKNOWLEDGED: "bg-muted text-muted-foreground",
  ESCALATED: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
  DISMISSED: "bg-muted text-muted-foreground line-through",
};

/**
 * Incidents, not cameras -- the design inversion (#18).
 *
 * A three-person control room cannot watch sixteen tiles, so the default
 * screen is a ranked list of open incidents and the camera grid is a separate
 * section. Acknowledge, escalate and dismiss are keys, because nobody should
 * be hunting a small target with a mouse at 3 a.m.
 */
export function IncidentsScreen() {
  const [showClosed, setShowClosed] = useState(false);
  const { incidents, loading, error, reload, merge } = useIncidents(showClosed);

  const [cursor, setCursor] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ decision: Decision; incident: Incident } | null>(null);
  const [pending, setPending] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);

  const selected = incidents[Math.min(cursor, incidents.length - 1)] ?? null;

  useEffect(() => {
    if (cursor > incidents.length - 1) setCursor(Math.max(0, incidents.length - 1));
  }, [incidents.length, cursor]);

  const decide = useCallback(
    async (incident: Incident, decision: Decision, reason?: string) => {
      setPending(true);
      try {
        merge(await api.decide(incident.id, decision, reason));
        toast.success(`Incident ${decision}d`, { description: incident.title });
        setPrompt(null);
        setReasonError(null);
      } catch (cause) {
        // The node requires a stated reason for escalate and dismiss and says
        // so with a 422. Open the dialog rather than swallowing it.
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
    [merge],
  );

  const act = useCallback(
    (incident: Incident | null, decision: Decision) => {
      if (!incident) return;
      if (decision === "acknowledge") void decide(incident, decision);
      else {
        setReasonError(null);
        setPrompt({ decision, incident });
      }
    },
    [decide],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal a key from someone typing a reason.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key.toLowerCase()) {
        case "arrowdown":
        case "j":
          event.preventDefault();
          setCursor((index) => Math.min(index + 1, incidents.length - 1));
          break;
        case "arrowup":
        case "k":
          event.preventDefault();
          setCursor((index) => Math.max(index - 1, 0));
          break;
        case "enter":
          if (selected) setOpenId(selected.id);
          break;
        case "escape":
          setOpenId(null);
          break;
        case "a":
          act(selected, "acknowledge");
          break;
        case "e":
          act(selected, "escalate");
          break;
        case "d":
          act(selected, "dismiss");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [incidents.length, selected, act]);

  const critical = useMemo(
    () => incidents.filter((incident) => incident.severity === "CRITICAL" && incident.status === "OPEN").length,
    [incidents],
  );

  return (
    <PageShell
      title="Incidents"
      description="Grouped detections, worst first. One incident is one piece of work — not one detection."
      actions={
        <div className="flex items-center gap-2">
          <Label htmlFor="show-closed" className="text-xs text-muted-foreground">
            Show closed
          </Label>
          <Switch id="show-closed" checked={showClosed} onCheckedChange={setShowClosed} />
        </div>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-mono">
            {incidents.length} shown
          </Badge>
          {critical > 0 && (
            <Badge variant="outline" className="border-destructive/40 bg-destructive/10 font-mono text-destructive">
              {critical} critical open
            </Badge>
          )}
          <span className="ml-auto hidden font-mono md:inline">
            ↑↓ move · ⏎ open · A ack · E escalate · D dismiss
          </span>
        </div>
      }
    >
      {error && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Could not load incidents</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading && <LoadingRows />}

      {!loading && !error && incidents.length === 0 && (
        <NothingHere
          icon={InboxIcon}
          title="Nothing open"
          description="No incident is waiting on a decision. Suppressed and logged-only detections are still in the event log."
        />
      )}

      {!loading && incidents.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Severity</TableHead>
                <TableHead>Incident</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="w-20 text-right">Events</TableHead>
                <TableHead className="w-32 text-right">Last seen</TableHead>
                <TableHead className="w-56" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.map((incident, index) => (
                <TableRow
                  key={incident.id}
                  data-state={index === cursor ? "selected" : undefined}
                  className={cn("cursor-pointer", index === cursor && "bg-muted/60")}
                  onClick={() => {
                    setCursor(index);
                    setOpenId(incident.id);
                  }}
                >
                  <TableCell>
                    <SeverityBadge severity={incident.severity} />
                  </TableCell>
                  <TableCell className="font-medium">{incident.title}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("font-mono text-xs", STATUS_STYLE[incident.status])}>
                      {incident.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{incident.eventCount}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {clockTime(incident.lastEventAt)}
                    <span className="block">{relative(incident.lastEventAt)}</span>
                  </TableCell>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => act(incident, "acknowledge")}>
                        <CheckIcon data-icon="inline-start" />
                        Ack
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => act(incident, "escalate")}>
                        <SirenIcon data-icon="inline-start" />
                        Escalate
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => act(incident, "dismiss")}>
                        <XIcon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <IncidentSheet incidentId={openId} onOpenChange={(open) => !open && setOpenId(null)} />

      <ReasonDialog
        open={prompt !== null}
        title={prompt?.decision === "escalate" ? "Escalate incident" : "Dismiss incident"}
        description={prompt?.incident.title ?? ""}
        confirmLabel={prompt?.decision === "escalate" ? "Escalate" : "Dismiss"}
        destructive={prompt?.decision === "dismiss"}
        pending={pending}
        error={reasonError}
        onOpenChange={(open) => !open && setPrompt(null)}
        onConfirm={(reason) => {
          if (prompt) void decide(prompt.incident, prompt.decision, reason);
        }}
      />
    </PageShell>
  );
}
