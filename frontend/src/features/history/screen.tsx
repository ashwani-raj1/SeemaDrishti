import { useState } from "react";
import { HistoryIcon, InfoIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageShell } from "@/components/ibvap/page-shell";
import { EventTable } from "@/components/ibvap/event-table";
import { NothingHere } from "@/components/ibvap/states";
import { Spinner } from "@/components/ibvap/spinner";
import { useClient } from "@/client/context";
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
  const [cameraId, setCameraId] = useState(ALL);
  const [severity, setSeverity] = useState(ALL);
  const [klass, setKlass] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [results, setResults] = useState<IbvapEvent[] | null>(null);
  const [searching, setSearching] = useState(false);

  const search = async () => {
    setSearching(true);
    try {
      const response = await api.history({
        camera_id: cameraId === ALL ? undefined : cameraId,
        severity: severity === ALL ? undefined : severity,
        class: klass || undefined,
        since: since ? new Date(since).toISOString() : undefined,
        until: until ? new Date(until).toISOString() : undefined,
        reason: reason || undefined,
        limit: 200,
      });
      setResults(response.results);
      toast.success(`${response.results.length} results`, {
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
      </FieldGroup>

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
      {results && results.length > 0 && <EventTable events={results} showDate />}
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
