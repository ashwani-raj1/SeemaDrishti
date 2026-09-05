import { useEffect, useState } from "react";
import { FileClockIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageShell } from "@/components/ibvap/page-shell";
import { ErrorState, LoadingRows, NothingHere } from "@/components/ibvap/states";
import { Spinner } from "@/components/ibvap/spinner";
import { api } from "@/lib/api";
import { onStream } from "@/lib/stream";
import { useResource } from "@/lib/use-resource";
import { dateTime } from "@/lib/format";
import type { Action, ChainVerdict } from "@/lib/types";

/**
 * The audit spine (#33).
 *
 * Append-only and hash-chained: each row's hash covers the previous row's, so
 * removing or rewriting any row breaks every hash after it. An incident's
 * status is derived from this table, which is why there is no code path that
 * can change one without leaving a row behind.
 */
export function AuditScreen() {
  const { data, error, loading, reload } = useResource(() => api.audit({ limit: 200 }), []);
  const [verdict, setVerdict] = useState<ChainVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => onStream("action", () => reload()), [reload]);

  const verify = async () => {
    setVerifying(true);
    try {
      setVerdict(await api.verifyChain());
    } finally {
      setVerifying(false);
    }
  };

  return (
    <PageShell
      title="Audit trail"
      description="Every acknowledgement, escalation, dismissal, zone edit and history search — who, when, and why."
      actions={
        <Button variant="outline" onClick={() => void verify()} disabled={verifying}>
          {verifying ? <Spinner data-icon="inline-start" /> : <ShieldCheckIcon data-icon="inline-start" />}
          Verify chain
        </Button>
      }
    >
      {verdict && (
        <Alert variant={verdict.ok ? "default" : "destructive"}>
          {verdict.ok ? <ShieldCheckIcon /> : <ShieldAlertIcon />}
          <AlertTitle>
            {verdict.ok
              ? `Chain intact across ${verdict.checked} records`
              : `Chain broken at record ${verdict.brokenAt}`}
          </AlertTitle>
          <AlertDescription>
            {verdict.ok
              ? "Every hash was recomputed from the beginning and matches. No row has been removed or rewritten."
              : "A row has been altered or removed. Everything after the named sequence is no longer trustworthy."}
          </AlertDescription>
        </Alert>
      )}

      {loading && <LoadingRows />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && (
        <NothingHere
          icon={FileClockIcon}
          title="No decisions recorded"
          description="Acknowledge or escalate an incident and it will appear here immediately."
        />
      )}

      {data && data.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Seq</TableHead>
                <TableHead className="w-40">When</TableHead>
                <TableHead className="w-48">Actor</TableHead>
                <TableHead className="w-48">Verb</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-32">Hash</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((action: Action) => (
                <TableRow key={action.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {action.seq}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{dateTime(action.at)}</TableCell>
                  <TableCell>
                    <span className="block truncate text-sm">{action.actor.name}</span>
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {action.actor.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-xs">
                      {action.verb}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-sm">
                    {action.reason ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="truncate font-mono text-[10px] text-muted-foreground">
                    {action.hash.slice(0, 12)}…
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageShell>
  );
}
