import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { onStream } from "@/lib/stream";
import { SEVERITY_RANK, type Incident } from "@/lib/types";

/** Worst first, then most recent. The order a tired operator should work in. */
export const rankIncidents = (list: Incident[]): Incident[] =>
  [...list].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt),
  );

const isOpen = (incident: Incident) =>
  incident.status === "OPEN" || incident.status === "ACKNOWLEDGED";

/**
 * The incident list, kept current by the node's own push rather than polling.
 *
 * A dismissed incident leaves the queue but is never deleted -- the event log
 * and the audit trail both still hold it.
 */
export function useIncidents(showClosed: boolean) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIncidents(rankIncidents(await api.incidents({ limit: 200 })));
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Upsert on push. A new incident must not wait for the next poll. */
  const merge = useCallback((incoming: Incident) => {
    setIncidents((current) => {
      const without = current.filter((existing) => existing.id !== incoming.id);
      return rankIncidents([...without, incoming]);
    });
  }, []);

  useEffect(() => {
    const offIncident = onStream("incident", (data) => merge(data as Incident));
    // An event can open an incident the screen has never seen; the event frame
    // carries no incident, so refetch rather than guess at one.
    const offEvent = onStream("event", () => void load());
    return () => {
      offIncident();
      offEvent();
    };
  }, [merge, load]);

  const visible = showClosed ? incidents : incidents.filter(isOpen);
  return { incidents: visible, total: incidents.length, loading, error, reload: load, merge };
}
