/**
 * Fetch-with-state, deliberately small.
 *
 * ponytail: hand-rolled instead of TanStack Query. The node pushes over SSE,
 * so most screens are told when to change rather than polling for it. Swap in
 * a real cache when cross-section invalidation actually starts hurting.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

export function useResource<T>(
  load: () => Promise<T>,
  deps: React.DependencyList = [],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Without this a slow first request can land after a fast second one and
  // overwrite newer data with older.
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setLoading(true);

    load()
      .then((result) => {
        if (mine !== generation.current) return;
        setData(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (mine !== generation.current) return;
        setError(
          cause instanceof ApiError ? cause : new ApiError(String(cause), 0),
        );
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** Re-runs `fn` on an interval. For the few screens with nothing to listen to. */
export function usePoll(fn: () => void, ms: number, enabled = true) {
  useEffect(() => {
    if (!enabled || ms <= 0) return;
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  }, [fn, ms, enabled]);
}
