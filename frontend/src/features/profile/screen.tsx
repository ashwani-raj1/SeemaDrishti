import { useState } from "react";
import { CheckCircle2Icon, InfoIcon, ReplaceIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageShell } from "@/components/ibvap/page-shell";
import { SeverityBadge } from "@/components/ibvap/badges";
import { Spinner } from "@/components/ibvap/spinner";
import { useClient } from "@/client/context";
import { SITE_PROFILES, type SiteProfile } from "@/client/profiles";
import { api } from "@/lib/api";
import { humanise } from "@/lib/format";

/**
 * The configuration switch (Plate 13) — the primary showcase.
 *
 * Same program, same database, same screen: only the profile changed. It is
 * the safer of the two demonstrations because it needs no AI computation at
 * all, so it behaves identically on whatever hardware turns up.
 *
 * Applying really does PATCH every zone, and each PATCH is recorded as a
 * decision — the change itself is auditable, which is the point.
 */
export function SiteProfileScreen() {
  const { cameras, site, org, refreshServer } = useClient();
  const [applying, setApplying] = useState<string | null>(null);

  const zones = cameras.flatMap((camera) => camera.zones);

  const apply = async (profile: SiteProfile) => {
    setApplying(profile.id);
    try {
      // Positional: a zone is a shape plus a label, and a profile supplies the
      // label. The shapes stay exactly where the site drew them.
      const pairs = zones.map((zone, index) => [zone, profile.zones[index]] as const);
      let changed = 0;

      for (const [zone, spec] of pairs) {
        if (!spec) continue;
        await api.updateZone(zone.id, {
          name: spec.name,
          kind: spec.kind,
          watchClasses: spec.watchClasses,
          logOnlyClasses: spec.logOnlyClasses,
          direction: spec.direction,
          severity: spec.severity,
          confirmSeconds: spec.confirmSeconds,
          reason: `Applied site profile: ${profile.label}`,
        });
        changed += 1;
      }

      await refreshServer();
      toast.success(`${profile.label} applied`, {
        description: `${changed} zones rewritten. Every change is in the audit trail.`,
      });
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setApplying(null);
    }
  };

  return (
    <PageShell
      title="Site profile"
      description="Everything force-specific lives in one file. Adapting to another force is writing a profile, not forking the code."
    >
      <Alert>
        <InfoIcon />
        <AlertTitle>
          {org?.name} · {site?.name}
        </AlertTitle>
        <AlertDescription>
          Applying a profile rewrites this site's {zones.length} zones in place. The shapes stay
          where they were drawn — only what they mean changes. No restart, and the switch itself is
          recorded as a decision.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        {SITE_PROFILES.map((profile) => (
          <Card key={profile.id}>
            <CardHeader>
              <CardTitle className="text-base">{profile.label}</CardTitle>
              <CardDescription>
                <Badge variant="secondary" className="mb-2 font-mono text-xs">
                  {profile.force}
                </Badge>
                <span className="block">{profile.summary}</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Zone</TableHead>
                    <TableHead className="w-32">Kind</TableHead>
                    <TableHead>Watch for</TableHead>
                    <TableHead className="w-24">Severity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {profile.zones.map((zone) => (
                    <TableRow key={zone.name}>
                      <TableCell className="text-sm font-medium">{zone.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">
                          {humanise(zone.kind)}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {zone.watchClasses.join(", ")}
                      </TableCell>
                      <TableCell>
                        <SeverityBadge severity={zone.severity} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
            <CardFooter>
              <Button
                onClick={() => void apply(profile)}
                disabled={applying !== null}
                className="w-full"
              >
                {applying === profile.id ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <ReplaceIcon data-icon="inline-start" />
                )}
                Apply {profile.label}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2Icon className="size-4" />
            Live zones on this site
          </CardTitle>
          <CardDescription>What the node is actually enforcing right now.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Zone</TableHead>
                <TableHead className="w-32">Kind</TableHead>
                <TableHead>Alert on</TableHead>
                <TableHead>Logged only</TableHead>
                <TableHead className="w-24">Hold</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {zones.map((zone) => (
                <TableRow key={zone.id}>
                  <TableCell className="text-sm font-medium">{zone.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-xs">
                      {humanise(zone.kind)}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {zone.watchClasses.join(", ")}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {zone.logOnlyClasses.join(", ") || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{zone.confirmSeconds}s</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </PageShell>
  );
}
