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
import { useResource } from "@/lib/use-resource";
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

  // The logical zones, not the per-camera bindings -- a zone spanning two
  // cameras is one row here, and one thing a profile rewrites.
  const zoneList = useResource(() => api.zones(), []);
  const zones = zoneList.data ?? [];

  const apply = async (profile: SiteProfile) => {
    setApplying(profile.id);
    try {
      // Positional: a zone is a place plus a policy, and a profile supplies the
      // policy. The shapes stay exactly where the site drew them.
      //
      // This relies on `api.zones()` being stably ordered (oldest first). A
      // newest-first list would re-map every zone the moment one was created,
      // renaming zones by accident. Zones past the end of the profile are
      // deliberately left alone rather than blanked.
      //
      // A profile zone now writes to three places, because the model separates
      // them: the zone's identity, its ordered targets, and each camera's own
      // direction and patience.
      const zones = await api.zones();
      let changed = 0;

      for (const [index, zone] of zones.entries()) {
        const spec = profile.zones[index];
        if (!spec) continue;

        await api.updateZone(zone.id, {
          name: spec.name,
          kind: spec.kind,
          reason: `Applied site profile: ${profile.label}`,
        });

        // Watched classes first, at the profile's severity; then the ones that
        // are only ever written down. Order is the priority.
        await api.setZoneTargets(
          zone.id,
          [
            ...spec.watchClasses.map((cls) => ({
              class: cls,
              severity: spec.severity,
              action: "alert",
            })),
            ...spec.logOnlyClasses.map((cls) => ({
              class: cls,
              severity: "INFO",
              action: "log_only",
            })),
          ],
          `Applied site profile: ${profile.label}`,
        );

        for (const camera of zone.cameras.filter((c) => c.active)) {
          await api.updateZoneCamera(zone.id, camera.cameraId, {
            direction: spec.direction,
            confirmSeconds: spec.confirmSeconds,
            reason: `Applied site profile: ${profile.label}`,
          });
        }

        changed += 1;
      }

      await refreshServer();
      zoneList.reload();
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
                    {zone.targets
                      .filter((target) => target.action === "alert")
                      .map((target) => target.class)
                      .join(", ") || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {zone.targets
                      .filter((target) => target.action === "log_only")
                      .map((target) => target.class)
                      .join(", ") || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {/* Each camera keeps its own patience, so show the range. */}
                    {[...new Set(zone.cameras.filter((c) => c.active).map((c) => c.confirmSeconds))]
                      .sort((a, b) => a - b)
                      .join("/")}s
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </PageShell>
  );
}
