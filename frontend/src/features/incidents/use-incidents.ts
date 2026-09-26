import { useCallback, useEffect, useMemo, useState } from "react";
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

/** Windows an operator actually asks for, in hours. `null` is everything. */
export const RANGES = [
  { id: "1h", label: "Last hour", hours: 1 },
  { id: "24h", label: "Last 24 hours", hours: 24 },
  { id: "7d", label: "Last 7 days", hours: 24 * 7 },
  { id: "all", label: "All time", hours: null },
] as const;

export type RangeId = (typeof RANGES)[number]["id"];

export interface IncidentFilters {
  /** Event kind, or "" for any. */
  kind: string;
  severity: string;
  /** Detected class, e.g. "person". */
  class: string;
  range: RangeId;
  /** Only incidents that actually raised an alert. */
  alertedOnly: boolean;
}

export const NO_FILTERS: IncidentFilters = {
  kind: "",
  severity: "",
  class: "",
  range: "24h",
  alertedOnly: false,
};

export const activeFilterCount = (filters: IncidentFilters): number =>
  (filters.kind ? 1 : 0) +
  (filters.severity ? 1 : 0) +
  (filters.class ? 1 : 0) +
  (filters.range !== NO_FILTERS.range ? 1 : 0) +
  (filters.alertedOnly ? 1 : 0);

/**
 * The incident list, kept current by the node's own push rather than polling.
 *
 * A dismissed incident leaves the queue but is never deleted -- the event log
 * and the audit trail both still hold it.
 *
 * WHERE EACH FILTER IS APPLIED, and it is not arbitrary. Kind, severity, class
 * and the date range go to the NODE, because they can exclude rows the browser
 * would otherwise have to download to throw away -- and the limit is 500, so a
 * client-side filter would quietly be filtering a truncated list and showing a
 * confident, wrong count. `alertedOnly` is applied here because it is a
 * property the payload already carries and needs no round trip.
 *
 * A filter change refetches. That is the point of pushing them down.
 */
export function useIncidents(showClosed: boolean, filters: IncidentFilters = NO_FILTERS) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const { kind, severity, class: klass, range } = filters;

  const load = useCallback(async () => {
    try {
      const hours = RANGES.find((entry) => entry.id === range)?.hours ?? null;
      setIncidents(
        rankIncidents(
          await api.incidents({
            limit: 200,
            kind: kind || undefined,
            severity: severity || undefined,
            class: klass || undefined,
            since: hours ? new Date(Date.now() - hours * 3600_000).toISOString() : undefined,
          }),
        ),
      );
      setError(null);
      setLoadedAt(new Date());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [kind, severity, klass, range]);

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

  /**
   * An explicit refresh, distinct from the automatic one.
   *
   * The screen is already live -- the node pushes. This exists because "is it
   * actually live, or has the link died quietly?" is a question an operator
   * will ask at 3 a.m., and the honest answer is a button that proves it by
   * fetching and stamping the time.
   */
  const refresh = useCallback(() => {
    setRefreshing(true);
    return load();
  }, [load]);

  const visible = useMemo(() => {
    let list = showClosed ? incidents : incidents.filter(isOpen);
    if (filters.alertedOnly) list = list.filter((incident) => incident.alertable !== false);
    return list;
  }, [incidents, showClosed, filters.alertedOnly]);

  return {
    incidents: visible,
    total: incidents.length,
    loading,
    refreshing,
    error,
    loadedAt,
    reload: load,
    refresh,
    merge,
  };
}
