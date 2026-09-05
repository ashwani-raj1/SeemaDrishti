import { useState } from "react";
import { PlayIcon, SquareIcon, ZapIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageShell } from "@/components/ibvap/page-shell";
import { ErrorState, LoadingRows } from "@/components/ibvap/states";
import { Spinner } from "@/components/ibvap/spinner";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { humanise } from "@/lib/format";

/** What each scenario is for, so the buttons are not a mystery. */
const SCENARIO_NOTE: Record<string, string> = {
  intruder: "A person crosses the fence line and holds — the alarm this exists for.",
  cattle: "A cow crosses the same line. Logged, never alerted (#12).",
  flicker: "A single-frame flicker. Rejected by the confirm delay (#13).",
  farmer_gate: "Lawful farm traffic through the gate on schedule.",
  patrol_road: "Own patrol on the road verge.",
  boat_waterline: "A boat at the waterline — the naval configuration.",
  drone_pickup: "Travel out, pause, return the same way — the retrieval pattern (#28).",
};

export function SimulatorScreen() {
  const { data, error, loading, reload } = useResource(() => api.sim(), []);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (name: string) => {
    setBusy(name);
    try {
      await api.simScenario(name);
      toast.success(`Ran ${humanise(name)}`, {
        description: "Watch the incident queue — grouping happens on the node.",
      });
      reload();
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async () => {
    setBusy("toggle");
    try {
      await (data?.running ? api.simStop() : api.simStart(true));
      reload();
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageShell
      title="Simulator"
      description="Feeds detections into the ingress hook as though a detector produced them."
      actions={
        data && (
          <Button variant={data.running ? "destructive" : "default"} onClick={() => void toggle()} disabled={busy !== null}>
            {busy === "toggle" ? (
              <Spinner data-icon="inline-start" />
            ) : data.running ? (
              <SquareIcon data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            {data.running ? "Stop ambient" : "Start ambient"}
          </Button>
        )
      }
    >
      <Alert>
        <ZapIcon />
        <AlertTitle>Everything from here is flagged simulated</AlertTitle>
        <AlertDescription>
          The flag is set once per adapter and travels in the event itself, so it cannot be
          forgotten at a call site. A made-up feed presented as real is the one thing that would
          sink this project.
        </AlertDescription>
      </Alert>

      {loading && <LoadingRows rows={3} />}
      {error && <ErrorState error={error} onRetry={reload} />}

      {data && (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge variant={data.running ? "default" : "secondary"} className="font-mono">
              {data.running ? "RUNNING" : "IDLE"}
            </Badge>
            <Badge variant="outline" className="font-mono">
              {data.walkers} walkers
            </Badge>
            <Badge variant="outline" className="font-mono">
              ambient {data.ambient ? "on" : "off"}
            </Badge>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.scenarios.map((name) => (
              <Card key={name}>
                <CardHeader>
                  <CardTitle className="text-base">{humanise(name)}</CardTitle>
                  <CardDescription>{SCENARIO_NOTE[name] ?? "Scenario."}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void run(name)}
                  >
                    {busy === name && <Spinner data-icon="inline-start" />}
                    Run
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </PageShell>
  );
}
