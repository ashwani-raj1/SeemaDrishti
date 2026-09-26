/**
 * One place that knows who is running this deployment, who is acting, and
 * whether the live push is alive.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, configureApi, setActor } from "@/lib/api";
import { connectStream, onStreamState, type StreamState } from "@/lib/stream";
import { connectLive } from "@/lib/live";
import type {
  AppUser, Camera, MediaConfig, NodeSettings, Organisation, Role, ServerConfig, Site,
} from "@/lib/types";
import { FALLBACK_CONFIG, loadClientConfig, type ClientConfig } from "./config";

interface ClientContextValue {
  ready: boolean;
  error: string | null;
  config: ClientConfig;
  org: Organisation | null;
  site: Site | null;
  cameras: Camera[];
  media: MediaConfig | null;
  /**
   * Node behaviour in force right now. Null until the first config load, and
   * refreshed by `refreshServer` after a settings write -- so a screen that
   * quotes the grouping window quotes the value the node is actually using.
   */
  settings: NodeSettings | null;
  users: AppUser[];
  actor: AppUser | null;
  role: Role;
  chooseActor: (id: string) => void;
  refreshServer: () => Promise<void>;
  stream: StreamState;
}

const ClientContext = createContext<ClientContextValue | null>(null);

const ACTOR_KEY = "ibvap.actor";

export function ClientProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<ClientConfig>(FALLBACK_CONFIG);
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [actorId, setActorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [stream, setStream] = useState<StreamState>("connecting");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const clientConfig = await loadClientConfig();
      if (cancelled) return;
      setConfig(clientConfig);
      configureApi(clientConfig.apiBase);

      try {
        const serverConfig = await api.config();
        if (cancelled) return;

        const remembered = localStorage.getItem(ACTOR_KEY);
        const chosen =
          serverConfig.users.find((user) => user.id === remembered) ?? serverConfig.users[0];
        if (chosen) {
          setActor(chosen.id);
          setActorId(chosen.id);
        }
        setServer(serverConfig);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // The tab belongs to the deployment, not to the build.
  useEffect(() => {
    document.title = site ? `${config.brand.name} · ${site.name}` : config.brand.name;
  }, [config.brand.name, server]);

  // Only worth a socket once we know where the node is.
  useEffect(() => {
    if (!ready || error) return;
    const stopWatching = onStreamState(setStream);
    const disconnect = connectStream();
    return () => {
      stopWatching();
      disconnect();
    };
  }, [ready, error]);

  // The live overlay channel, kept separate from the event stream above on
  // purpose: it comes from a different process, carries ephemeral data rather
  // than the record, and must be able to die without taking the record with
  // it. Its address arrives with the rest of the server config.
  const boxesUrl = server?.media?.boxesUrl;
  useEffect(() => {
    if (!boxesUrl) return;
    return connectLive(boxesUrl);
  }, [boxesUrl]);

  const chooseActor = useCallback(
    (id: string) => {
      setActor(id);
      setActorId(id);
      localStorage.setItem(ACTOR_KEY, id);
    },
    [],
  );

  const refreshServer = useCallback(async () => {
    setServer(await api.config());
  }, []);

  const site = server?.site ?? null;

  const actor = useMemo(
    () => server?.users.find((user) => user.id === actorId) ?? null,
    [server, actorId],
  );

  const value = useMemo<ClientContextValue>(
    () => ({
      ready,
      error,
      config,
      org: server?.org ?? null,
      site: server?.site ?? null,
      cameras: server?.cameras ?? [],
      media: server?.media ?? null,
      settings: server?.settings ?? null,
      users: server?.users ?? [],
      actor,
      role: actor?.role ?? "operator",
      chooseActor,
      refreshServer,
      stream,
    }),
    [ready, error, config, server, actor, chooseActor, refreshServer, stream],
  );

  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

export function useClient(): ClientContextValue {
  const value = useContext(ClientContext);
  if (!value) throw new Error("useClient must be used inside <ClientProvider>");
  return value;
}

/** Every camera's zones, flattened -- the shape most screens actually want. */
export function useZones() {
  const { cameras } = useClient();
  return useMemo(() => cameras.flatMap((camera) => camera.zones), [cameras]);
}
