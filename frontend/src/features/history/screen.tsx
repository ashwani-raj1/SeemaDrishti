import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { HistoryIcon, InfoIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageShell } from "@/components/ibvap/page-shell";
import { EventTable } from "@/components/ibvap/event-table";
import { NothingHere } from "@/components/ibvap/states";
import { Spinner } from "@/components/ibvap/spinner";
import { useClient, useZones } from "@/client/context";
import { api } from "@/lib/api";
import type { IbvapEvent } from "@/lib/types";

const ALL = "__all__";

/**
 * Looking backwards through the record (#32) — supervisors only.
 *
 * Every search is itself written to the audit log, so "who went looking, and
 * for what" is as answerable as "who dismissed this alarm". The screen says so
 * plainly rather than hiding it, because the node does it either way.
 */
export function HistoryScreen() {
  const { cameras } = useClient();
  // useZones flattens every camera's zones, so a zone watched by two cameras
  // appears twice -- which would put duplicate keys and duplicate options in
  // the select below. The filter is by zone id, so one entry per zone is right.
  const zones = useZones();
  const zoneOptions = useMemo(() => {
    const byId = new Map<string, (typeof zones)[number]>();
    for (const zone of zones) if (!byId.has(zone.id)) byId.set(zone.id, zone);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [zones]);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [cameraId, setCameraId] = useState(params.get("camera_id") ?? ALL);
  const [zoneId, setZoneId] = useState(params.get("zone_id") ?? ALL);
  const [severity, setSeverity] = useState(ALL);
  const [klass, setKlass] = useState("");
  const [kind, setKind] = useState(params.get("kind") ?? ALL);
  const [alertableOnly, setAlertableOnly] = useState(false);
  const [provisionalOnly, setProvisionalOnly] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [results, setResults] = useState<IbvapEvent[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Filters arrive from a link; the SEARCH does not run by itself. A search
  // here writes an audit row against this operator's name, and firing one
  // because somebody followed a link would make the audit trail describe an
  // intention nobody had.
  const [fromLink, setFromLink] = useState(false);
  useEffect(() => {
    setFromLink(params.has("camera_id") || params.has("zone_id") || params.has("kind"));
  }, [params]);

  const search = async () => {
    setSearching(true);
    try {
      const response = await api.history({
        camera_id: cameraId === ALL ? undefined : cameraId,
        zone_id: zoneId === ALL ? undefined : zoneId,
        severity: severity === ALL ? undefined : severity,
        class: klass || undefined,
        kind: kind === ALL ? undefined : kind,
        // Tri-state on the wire: left out entirely unless asked for, so the
        // default search still returns suppressed rows alongside alerted ones.
        alertable: alertableOnly ? true : undefined,
        since: since ? new Date(since).toISOString() : undefined,
        until: until ? new Date(until).toISOString() : undefined,
        reason: reason || undefined,
        limit: 200,
      });
      // Filtered here rather than on the server: `provisional` lives inside the
      // evidence JSON, and indexing a JSON field to answer it would cost more
      // than scanning 200 rows in the browser.
      const rows = provisionalOnly
        ? response.results.filter((event) => event.evidence?.provisional === true)
        : response.results;
      setResults(rows);
      setFromLink(false);
      toast.success(`${rows.length} results`, {
        description: "This search has been recorded in the audit trail.",
      });
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setSearching(false);
    }
  };

  return (
    <PageShell
      title="History search"
      description="Investigators need to look backwards, not only watch live."
    >
      <Alert>
        <InfoIcon />
        <AlertTitle>This search is recorded</AlertTitle>
        <AlertDescription>
          The node writes a <code className="font-mono">history.search</code> action against your
          name, with the query and the result count. Accountability here is a side effect of how
          the database is shaped, not a promise on a slide.
        </AlertDescription>
      </Alert>

      <FieldGroup className="md:grid md:grid-cols-3 md:gap-4">
        <Field>
          <FieldLabel htmlFor="h-camera">Camera</FieldLabel>
          <Select value={cameraId} onValueChange={setCameraId}>
            <SelectTrigger id="h-camera">
              <SelectValue placeholder="All cameras" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All cameras</SelectItem>
                {cameras.map((camera) => (
                  <SelectItem key={camera.id} value={camera.id}>
                    {camera.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor="h-zone">Zone</FieldLabel>
          <Select value={zoneId} onValueChange={setZoneId}>
            <SelectTrigger id="h-zone">
              <SelectValue placeholder="All zones" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All zones</SelectItem>
                {zoneOptions.map((zone) => (
                  <SelectItem key={zone.id} value={zone.id}>
                    {zone.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor="h-kind">Kind</FieldLabel>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger id="h-kind">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>Any kind</SelectItem>
                <SelectItem value="zone_crossing">Zone crossing</SelectItem>
                <SelectItem value="sensor_contact">Sensor contact</SelectItem>
                <SelectItem value="camera_health">Camera health</SelectItem>
                <SelectItem value="reidentification">Re-identification</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor="h-sev">Severity</FieldLabel>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger id="h-sev">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>Any severity</SelectItem>
                <SelectItem value="INFO">INFO</SelectItem>
                <SelectItem value="WARNING">WARNING</SelectItem>
                <SelectItem value="CRITICAL">CRITICAL</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor="h-class">Class</FieldLabel>
          <Input
            id="h-class"
            value={klass}
            placeholder="person, cattle, boat…"
            onChange={(event) => setKlass(event.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="h-since">From</FieldLabel>
          <Input
            id="h-since"
            type="datetime-local"
            value={since}
            onChange={(event) => setSince(event.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="h-until">To</FieldLabel>
          <Input
            id="h-until"
            type="datetime-local"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="h-reason">Reason for search</FieldLabel>
          <Input
            id="h-reason"
            value={reason}
            placeholder="Why are you looking?"
            onChange={(event) => setReason(event.target.value)}
          />
          <FieldDescription>Stored with the search.</FieldDescription>
        </Field>

        <Field orientation="horizontal">
          <Switch id="h-alertable" checked={alertableOnly} onCheckedChange={setAlertableOnly} />
          <div>
            <FieldLabel htmlFor="h-alertable">Alerted only</FieldLabel>
            <FieldDescription>
              Off by default, so a search still shows what was recorded and
              deliberately not raised.
            </FieldDescription>
          </div>
        </Field>

        <Field orientation="horizontal">
          <Switch
            id="h-provisional"
            checked={provisionalOnly}
            onCheckedChange={setProvisionalOnly}
          />
          <div>
            <FieldLabel htmlFor="h-provisional">Undrawn shapes only</FieldLabel>
            <FieldDescription>
              What fired against a default region nobody positioned.
            </FieldDescription>
          </div>
        </Field>
      </FieldGroup>

      {fromLink && (
        <p className="text-sm text-muted-foreground">
          Filters set from where you came. Press Search — nothing is queried
          until you do, because the search is recorded against your name.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={() => void search()} disabled={searching}>
          {searching ? <Spinner data-icon="inline-start" /> : <SearchIcon data-icon="inline-start" />}
          Search
        </Button>
        {results && (
          <Badge variant="outline" className="font-mono">
            {results.length} results
          </Badge>
        )}
      </div>

      {results === null && (
        <NothingHere
          icon={HistoryIcon}
          title="No search yet"
          description="Set a filter and search. Leaving everything blank returns the most recent events."
        />
      )}
      {results && results.length > 0 && (
        <EventTable
          events={results}
          showDate
          showPlace
          onOpen={(event) => navigate(`/incidents/${event.incidentId}`)}
        />
      )}
      {results && results.length === 0 && (
        <NothingHere
          icon={HistoryIcon}
          title="Nothing matched"
          description="No events for that query. The search was still recorded."
        />
      )}
    </PageShell>
  );
}
