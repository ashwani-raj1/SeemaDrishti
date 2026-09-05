import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PageShell } from "@/components/ibvap/page-shell";
import { CameraStatusPill } from "@/components/ibvap/badges";
import { CameraMap } from "@/components/ibvap/camera-map";
import { useClient } from "@/client/context";
import { humanise } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The feeds this site reads, and the zones drawn over each one. */
export function CamerasScreen() {
  const { cameras } = useClient();
  const [params] = useSearchParams();
  const wanted = params.get("camera");
  const focused = useRef<HTMLDivElement | null>(null);

  // Followed through from a map marker: put it under the eye, not just on the page.
  useEffect(() => {
    focused.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [wanted]);

  return (
    <PageShell
      title="Cameras"
      description="Ordinary IP cameras over RTSP. No proprietary boxes, no smart hardware — that constraint is the project."
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cameras.map((camera) => (
          <Card
            key={camera.id}
            ref={camera.id === wanted ? focused : undefined}
            className={cn(camera.id === wanted && "ring-2 ring-primary")}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <span className="truncate">{camera.name}</span>
                <CameraStatusPill status={camera.status} className="ml-auto" />
              </CardTitle>
              <CardDescription className="font-mono text-xs">{camera.id}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <CameraMap camera={camera} className="aspect-video w-full" showSwitcher />
              {camera.zones.map((zone) => (
                <div key={zone.id} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{zone.name}</span>
                    <Badge variant="outline" className="font-mono text-xs">
                      {humanise(zone.kind)}
                    </Badge>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {zone.direction}
                    </Badge>
                  </div>
                  <Separator />
                </div>
              ))}
              {camera.zones.length === 0 && (
                <p className="text-sm text-muted-foreground">No zones drawn on this feed.</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
