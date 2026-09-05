import { useState } from "react";
import { SaveIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageShell } from "@/components/ibvap/page-shell";
import { EvidenceOverlay } from "@/components/ibvap/evidence-overlay";
import { SeverityBadge } from "@/components/ibvap/badges";
import { Spinner } from "@/components/ibvap/spinner";
import { useClient } from "@/client/context";
import { api } from "@/lib/api";
import { humanise } from "@/lib/format";
import type { Direction, Severity, Zone, ZoneKind } from "@/lib/types";

const KINDS: ZoneKind[] = [
  "fence_line", "gate", "waterline", "perimeter", "pass", "restricted_area",
];
const DIRECTIONS: (Direction | "both")[] = ["inbound", "outbound", "both"];
const SEVERITIES: Severity[] = ["INFO", "WARNING", "CRITICAL"];

/**
 * A zone is a shape plus a label saying what kind of place it is (#38).
 *
 * A border fence line and a naval jetty perimeter are the same primitive with
 * a different kind — which is exactly why there is no force-specific code
 * anywhere. Editing one is recorded as a decision like any other.
 */
export function ZonesScreen() {
  const { cameras, refreshServer } = useClient();

  return (
    <PageShell
      title="Zones"
      description="Shapes over the camera's view. Points are normalised, so a zone survives the camera being swapped for a different resolution."
    >
      <div className="grid gap-4 xl:grid-cols-2">
        {cameras.flatMap((camera) =>
          camera.zones.map((zone) => (
            <ZoneCard
              key={zone.id}
              zone={zone}
              cameraName={camera.name}
              onSaved={refreshServer}
            />
          )),
        )}
      </div>
    </PageShell>
  );
}

function ZoneCard({
  zone,
  cameraName,
  onSaved,
}: {
  zone: Zone;
  cameraName: string;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(zone);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const dirty =
    draft.kind !== zone.kind ||
    draft.direction !== zone.direction ||
    draft.severity !== zone.severity ||
    draft.confirmSeconds !== zone.confirmSeconds ||
    draft.watchClasses.join() !== zone.watchClasses.join() ||
    draft.logOnlyClasses.join() !== zone.logOnlyClasses.join();

  const save = async () => {
    setSaving(true);
    try {
      await api.updateZone(zone.id, {
        kind: draft.kind,
        direction: draft.direction,
        severity: draft.severity,
        confirmSeconds: draft.confirmSeconds,
        watchClasses: draft.watchClasses,
        logOnlyClasses: draft.logOnlyClasses,
        reason: reason || undefined,
      });
      await onSaved();
      toast.success(`${zone.name} updated`, { description: "Recorded as a decision." });
      setReason("");
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const asList = (value: string) =>
    value.split(",").map((item) => item.trim()).filter(Boolean);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="truncate">{zone.name}</span>
          <SeverityBadge severity={draft.severity} className="ml-auto" />
        </CardTitle>
        <CardDescription>
          {cameraName} · <span className="font-mono">{zone.geometry}</span> ·{" "}
          {zone.points.length} points
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <EvidenceOverlay evidence={{ zone: { ...draft } }} className="aspect-video w-full" />

        <FieldGroup className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor={`kind-${zone.id}`}>Kind</FieldLabel>
            <Select
              value={draft.kind}
              onValueChange={(value) => setDraft({ ...draft, kind: value as ZoneKind })}
            >
              <SelectTrigger id={`kind-${zone.id}`} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {humanise(kind)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor={`dir-${zone.id}`}>Direction</FieldLabel>
            <Select
              value={draft.direction}
              onValueChange={(value) =>
                setDraft({ ...draft, direction: value as Direction | "both" })
              }
            >
              <SelectTrigger id={`dir-${zone.id}`} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {DIRECTIONS.map((direction) => (
                    <SelectItem key={direction} value={direction}>
                      {direction}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor={`sev-${zone.id}`}>Severity</FieldLabel>
            <Select
              value={draft.severity}
              onValueChange={(value) => setDraft({ ...draft, severity: value as Severity })}
            >
              <SelectTrigger id={`sev-${zone.id}`} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SEVERITIES.map((severity) => (
                    <SelectItem key={severity} value={severity}>
                      {severity}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor={`hold-${zone.id}`}>Confirm delay</FieldLabel>
            <Input
              id={`hold-${zone.id}`}
              type="number"
              min={0}
              max={60}
              step={0.5}
              value={draft.confirmSeconds}
              onChange={(event) =>
                setDraft({ ...draft, confirmSeconds: Number(event.target.value) })
              }
            />
            {/* The trade is stated openly: two seconds is defensible, fifteen is not. */}
            <FieldDescription>Seconds held before shouting.</FieldDescription>
          </Field>
        </FieldGroup>

        <Field>
          <FieldLabel htmlFor={`watch-${zone.id}`}>Alert on</FieldLabel>
          <Input
            id={`watch-${zone.id}`}
            value={draft.watchClasses.join(", ")}
            onChange={(event) =>
              setDraft({ ...draft, watchClasses: asList(event.target.value) })
            }
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={`log-${zone.id}`}>Log only, never alert</FieldLabel>
          <Input
            id={`log-${zone.id}`}
            value={draft.logOnlyClasses.join(", ")}
            onChange={(event) =>
              setDraft({ ...draft, logOnlyClasses: asList(event.target.value) })
            }
          />
          <FieldDescription>
            An animal crossing the fence is written to the log and never alerted on (#12).
          </FieldDescription>
        </Field>

        <div className="flex flex-wrap items-end gap-2">
          <Field className="flex-1">
            <FieldLabel htmlFor={`reason-${zone.id}`}>Reason</FieldLabel>
            <Input
              id={`reason-${zone.id}`}
              value={reason}
              placeholder="Why this change?"
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <Button disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            Save
          </Button>
        </div>

        {dirty && (
          <Badge variant="outline" className="w-fit border-amber-500/40 text-amber-700 dark:text-amber-300">
            Unsaved changes
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
