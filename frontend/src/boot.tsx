import { BrowserRouter } from "react-router-dom";
import { RadioTowerIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ClientProvider, useClient } from "@/client/context";
import { AppRoutes } from "@/app/shell";

/**
 * Nothing renders until the deployment's own configuration has loaded, because
 * the sidebar, the routes and the API base all come from it.
 */
function Boot() {
  const { ready, error, config } = useClient();

  if (!ready) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <RadioTowerIcon className="size-5 animate-pulse" />
          <span className="text-sm">Reaching the edge node…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid h-full place-items-center p-6">
        <Alert variant="destructive" className="max-w-lg">
          <TriangleAlertIcon />
          <AlertTitle>Cannot reach the edge node</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <p className="text-xs">
              Expected it at <code className="font-mono">{config.apiBase}</code>. Start it with{" "}
              <code className="font-mono">bun index.ts</code> in <code className="font-mono">backend/</code>,
              or point <code className="font-mono">apiBase</code> in{" "}
              <code className="font-mono">client.json</code> somewhere else.
            </p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return <AppRoutes />;
}

export function App() {
  return (
    <BrowserRouter>
      <ClientProvider>
        <Boot />
      </ClientProvider>
    </BrowserRouter>
  );
}
