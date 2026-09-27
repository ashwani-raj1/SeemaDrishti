import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  DatabaseIcon, LayersIcon, MonitorIcon, ServerIcon, ShieldAlertIcon, TriangleAlertIcon,
  UserCogIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageShell } from "@/components/ibvap/page-shell";
import { Spinner } from "@/components/ibvap/spinner";
import { useClient } from "@/client/context";
import { useConsoleStore } from "@/client/console-store";
import { api, isForbidden, isNotFound } from "@/lib/api";
import type { ResetCounts } from "@/lib/types";

/**
 * The bounds the node enforces, mirrored so the form can refuse before the
 * round trip. The node validates again -- this is a courtesy, not the rule.
 */
const MIN_GROUPING_WINDOW = 0;
const MAX_GROUPING_WINDOW = 3600;

/**
 * Settings.
 *
 * WHAT BELONGS HERE. Things about this console and this deployment that an
 * operator can change or needs to be able to read off. What does NOT belong
 * here is anything about what the system watches -- zones, cameras, targets and
 * the watchlist each have their own screen where the change is audited against
 * a reason. A settings page that quietly became a second way to edit coverage
 * would be a second place to look when somebody asks why a fence stopped
 * alerting.
 *
 * Most of this page is therefore read-only: addresses, versions, who is acting.
 * The one destructive control on it is fenced off behind three locks and is
 * absent entirely on a real node.
 *
 * INCIDENT GROUPING IS THE EXCEPTION, and it is worth saying why it does not
 * break the rule above. It changes nothing about what is watched or what is
 * alerted on -- every zone, target and severity is exactly as it was. It
 * changes only how the events that result are FILED: whether two crossings a
 * few minutes apart reach an operator as one piece of work or two. There is no
 * other screen that could own that, because it is not a property of any one
 * zone or camera. It is still a decision, so it is supervisor-only and lands
 * in the audit log with a before and an after.
 */
export function SettingsScreen() {
  const { config, site, org, media, actor, users, role, chooseActor, stream } = useClient();
  const { theme, setTheme } = useTheme();

  return (
    <PageShell
      title="Settings"
      description="This console, this node, and the one button that empties the record."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── who is acting ─────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <UserCogIcon className="size-4" /> Operator
            </CardTitle>
            <CardDescription>
              Every write is recorded against this name. Changing it changes who
              the audit log says did the next thing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="settings-actor">Acting as</Label>
              <Select value={actor?.id ?? undefined} onValueChange={chooseActor}>
                <SelectTrigger id="settings-actor">
                  <SelectValue placeholder="Choose an operator" />
                </SelectTrigger>
                <SelectContent>
                  {users.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.name} · {user.role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Fact label="Role" value={role} />
          </CardContent>
        </Card>

        {/* ── this browser ──────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <MonitorIcon className="size-4" /> This terminal
            </CardTitle>
            <CardDescription>
              Kept in this browser only. Never sent anywhere, never audited.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="settings-theme">Appearance</Label>
              <Select value={theme ?? "system"} onValueChange={setTheme}>
                <SelectTrigger id="settings-theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">Follow the system</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Separator />
            <RememberedSelections />
          </CardContent>
        </Card>

        {/* ── where everything is ───────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <ServerIcon className="size-4" /> Deployment
            </CardTitle>
            <CardDescription>
              Read-only. These come from the repo-root <code>.env</code> and{" "}
              <code>client.json</code> — changing one means editing a file on the
              machine, which is what keeps a console from being able to point
              itself somewhere else.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Organisation" value={org?.name ?? "—"} />
            <Fact label="Site" value={site?.name ?? "—"} />
            <Fact label="Node" value={config.apiBase || "same origin"} />
            <Fact label="Media hub (WHEP)" value={media?.whepBase ?? "—"} />
            <Fact label="Live observations" value={media?.boxesUrl ?? "—"} />
            <Fact
              label="Node stream"
              value={
                stream === "live" ? "connected" : stream === "connecting" ? "connecting" : "down"
              }
            />
          </CardContent>
        </Card>

        {/* ── how events are filed ──────────────────────────────────── */}
        <div className="lg:col-span-2">
          <GroupingPanel />
        </div>

        {/* ── the dangerous one ─────────────────────────────────────── */}
        <div className="lg:col-span-2">
          <ResetPanel />
        </div>
      </div>
    </PageShell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-sm">{value}</dd>
    </div>
  );
}

/** What this seat has remembered, and a way to forget it. */
function RememberedSelections() {
  const cameraByModule = useConsoleStore((state) => state.cameraByModule);
  const zoneFilter = useConsoleStore((state) => state.zoneFilter);
  const remembered = Object.keys(cameraByModule).length + (zoneFilter ? 1 : 0);

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Remembered selections</p>
        <p className="text-xs text-muted-foreground">
          {remembered === 0
            ? "Nothing remembered yet."
            : `${remembered} selection${remembered === 1 ? "" : "s"} — the camera each service page opens on, and the header's zone filter.`}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={remembered === 0}
        onClick={() => {
          useConsoleStore.setState({ cameraByModule: {}, zoneFilter: null });
          toast.success("Forgotten");
        }}
      >
        Forget
      </Button>
    </div>
  );
}

/**
 * Empty the operational record. Developer boxes only.
 *
 * THIS PANEL IS ABSENT ON A REAL NODE, not disabled. `GET /api/admin/reset`
 * 404s unless `IBVAP_DEBUG` is on, and a 404 here is treated as the normal
 * answer rather than an error -- a greyed-out "delete everything" button is
 * still an invitation, and an operator who can see it will eventually ask
 * somebody to turn it on for them.
 *
 * The typed confirmation is not ceremony. The event log is append-only by
 * schema trigger precisely so that this cannot happen by accident, and a
 * one-click version of it would be the accident.
 */
function ResetPanel() {
  const { role } = useClient();
  const [counts, setCounts] = useState<ResetCounts | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const canReset = role === "supervisor" || role === "admin";

  const refresh = () => {
    api
      .resetPreview()
      .then((body) => {
        setAvailable(true);
        setCounts(body.counts);
      })
      .catch((error) => {
        // 404 = not a developer node. 403 = not a supervisor. Both mean "you
        // do not get this button", and neither is worth an error toast.
        setAvailable(isNotFound(error) || isForbidden(error) ? false : false);
      });
  };

  useEffect(refresh, []);

  if (available === null) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Spinner /> Checking what this node allows…
        </CardContent>
      </Card>
    );
  }

  if (!available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <DatabaseIcon className="size-4" /> Operational record
          </CardTitle>
          <CardDescription>
            This node keeps its record permanently. The event log is append-only
            by schema trigger and there is no way to empty it from the console —
            which is what makes the log worth anything as evidence.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const total =
    (counts?.events ?? 0) +
    (counts?.incidents ?? 0) +
    (counts?.alerts ?? 0) +
    (counts?.trackedThings ?? 0) +
    (counts?.plateDetections ?? 0);

  const problem =
    !canReset ? "Needs a shift supervisor."
    : reason.trim().length < 3 ? "Say why, in a few words."
    : confirm !== "RESET" ? 'Type RESET to confirm.'
    : total === 0 ? "There is nothing to clear."
    : null;

  const run = async () => {
    setBusy(true);
    try {
      const { removed } = await api.reset(reason.trim());
      toast.success("Operational record cleared", {
        description: `${removed.events} events, ${removed.incidents} incidents. The audit log kept the record of this.`,
      });
      setReason("");
      setConfirm("");
      refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold text-destructive">
          <ShieldAlertIcon className="size-4" /> Clear the operational record
          <Badge variant="outline" className="border-amber-500/50 text-[10px] uppercase text-amber-600 dark:text-amber-500">
            developer node
          </Badge>
        </CardTitle>
        <CardDescription>
          Deletes every event, incident, alert, tracked subject and plate
          detection at this site. Cameras, zones, users and the watchlist are
          left alone.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle className="text-xs">
            The event log is append-only, and this is the exception
          </AlertTitle>
          <AlertDescription className="text-xs">
            A schema trigger normally refuses to delete an event — that is the
            tamper-evident log this system claims. Clearing it drops that guard,
            deletes, and puts it straight back, in one transaction.{" "}
            <strong className="font-medium">The audit log is never cleared</strong>,
            so the record of who emptied this and why survives the emptying.
          </AlertDescription>
        </Alert>

        <div className="grid gap-3 sm:grid-cols-5">
          <Counter label="Events" value={counts?.events ?? 0} />
          <Counter label="Incidents" value={counts?.incidents ?? 0} />
          <Counter label="Alerts" value={counts?.alerts ?? 0} />
          <Counter label="Tracked" value={counts?.trackedThings ?? 0} />
          <Counter label="Plate reads" value={counts?.plateDetections ?? 0} />
        </div>

        <Separator />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="reset-reason">Reason</Label>
            <Input
              id="reset-reason"
              value={reason}
              disabled={!canReset}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. clearing demo data before the run-through"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-confirm">
              Type <code className="font-mono font-semibold">RESET</code> to confirm
            </Label>
            <Input
              id="reset-confirm"
              value={confirm}
              disabled={!canReset}
              onChange={(event) => setConfirm(event.target.value)}
              placeholder="RESET"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {problem ?? `${total} rows will be deleted. This cannot be undone.`}
          </p>
          <Button variant="destructive" disabled={Boolean(problem) || busy} onClick={run}>
            {busy ? <Spinner /> : <DatabaseIcon className="size-4" />}
            {busy ? "Clearing…" : "Clear the record"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

/** Seconds as something a person reads without counting zeros. */
function humanWindow(seconds: number): string {
  if (seconds === 0) return "no grouping";
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = seconds / 60;
  if (Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${Math.floor(minutes)} min ${seconds % 60} s`;
}

/** The windows worth one click. Anything else is typed in. */
const PRESETS = [
  { seconds: 60, label: "1 min", hint: "open ground, subjects pass straight through" },
  { seconds: 300, label: "5 min", hint: "the default" },
  { seconds: 900, label: "15 min", hint: "a gate where vehicles queue" },
  { seconds: 1800, label: "30 min", hint: "a slow approach on foot" },
];

/**
 * How long an incident stays open to new events.
 *
 * WHY THIS IS A SETTING AT ALL. It was a constant, 300 seconds, chosen for no
 * recorded reason -- and the right value is not a property of the software. A
 * fence line in open country and a farm gate where tractors queue want
 * different answers, and the cost of the wrong one runs in both directions:
 * too wide and a second genuine intrusion is filed under the first one's
 * headline; too narrow and one person walking a fence line becomes forty
 * separate incidents to triage.
 *
 * The three consequences spelled out in the panel are the ones that surprise
 * people, so they are on the screen rather than in a document nobody opens:
 * the window slides, severity is worst-wins, and a dismissal is permanent.
 */
function GroupingPanel() {
  const { settings, role, refreshServer } = useClient();
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const current = settings?.groupingWindowSeconds ?? null;
  const canEdit = role === "supervisor" || role === "admin";

  // Follow the node's value when it loads or changes underneath us. Keyed off
  // `current` rather than run on every render, so it cannot fight the input
  // while somebody is typing in it.
  useEffect(() => {
    if (current !== null) setDraft(String(current));
  }, [current]);

  if (current === null) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Spinner /> Reading what this node is doing…
        </CardContent>
      </Card>
    );
  }

  const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
  const valid =
    Number.isInteger(parsed) && parsed >= MIN_GROUPING_WINDOW && parsed <= MAX_GROUPING_WINDOW;
  const changed = valid && parsed !== current;

  const problem =
    !canEdit ? "Needs a shift supervisor."
    : !valid ? `A whole number of seconds, ${MIN_GROUPING_WINDOW}–${MAX_GROUPING_WINDOW}.`
    : !changed ? "This is the value already in force."
    : null;

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.updateSettings({
        groupingWindowSeconds: parsed,
        reason: reason.trim() || undefined,
      });
      // The window travels on /api/config, so every screen quoting it updates
      // from one place rather than from this component's local state.
      await refreshServer();
      setReason("");
      toast.success("Grouping window changed", {
        description: `Now ${humanWindow(next.groupingWindowSeconds)}. Incidents already open keep the events they have.`,
      });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <LayersIcon className="size-4" /> Incident grouping
        </CardTitle>
        <CardDescription>
          Events from the same camera and zone arriving within this window are filed
          as one incident. It changes nothing about what is watched or what is
          alerted on — only how much of it counts as one piece of work.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="grouping-window">Window (seconds)</Label>
            <Input
              id="grouping-window"
              type="number"
              inputMode="numeric"
              min={MIN_GROUPING_WINDOW}
              max={MAX_GROUPING_WINDOW}
              step={10}
              value={draft}
              disabled={!canEdit}
              onChange={(event) => setDraft(event.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              {valid ? humanWindow(parsed) : `${MIN_GROUPING_WINDOW}–${MAX_GROUPING_WINDOW}`}
              {changed && <> · was {humanWindow(current)}</>}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Common windows</Label>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.seconds}
                  type="button"
                  size="sm"
                  variant={parsed === preset.seconds ? "secondary" : "outline"}
                  disabled={!canEdit}
                  onClick={() => setDraft(String(preset.seconds))}
                  title={preset.hint}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {PRESETS.find((preset) => preset.seconds === parsed)?.hint ??
                "Or type any window up to an hour."}
            </p>
          </div>
        </div>

        {/*
          The three things people get wrong about this number, on the screen
          rather than in a document, because the person changing it is exactly
          the person who needs them.
        */}
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle className="text-xs">What this window does, exactly</AlertTitle>
          <AlertDescription className="text-xs">
            <ul className="list-disc space-y-1 pl-4">
              <li>
                It <strong className="font-medium">slides</strong> — measured from the
                incident's most recent event, not from when it opened. Continuous
                activity keeps one incident alive indefinitely.
              </li>
              <li>
                Severity is <strong className="font-medium">worst-wins</strong>. A later,
                more serious event rewrites the incident's severity and its headline.
              </li>
              <li>
                A <strong className="font-medium">dismissed incident never reopens</strong>,
                whatever this is set to. The next event starts a fresh one.
              </li>
            </ul>
          </AlertDescription>
        </Alert>

        <Separator />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="grouping-reason">Reason (optional, recorded)</Label>
            <Input
              id="grouping-reason"
              value={reason}
              disabled={!canEdit}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. tractors queue at the farm gate past five minutes"
            />
          </div>
          <div className="flex items-end justify-end">
            <Button disabled={Boolean(problem) || busy} onClick={save}>
              {busy ? <Spinner /> : null}
              {busy ? "Saving…" : "Change the window"}
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {problem ??
            "Recorded against your name in the audit trail. It applies to events recorded from now on — incidents already open keep the events they already have."}
        </p>
      </CardContent>
    </Card>
  );
}
