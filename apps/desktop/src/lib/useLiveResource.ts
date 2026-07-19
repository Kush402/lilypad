import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Race-safe async resource.
 *
 * Every data surface in the dashboard is refreshed from multiple triggers —
 * a `lilypad://session` event, a periodic poll, an optimistic reconcile after
 * a mutation — which means several `refresh()` calls can be in flight at once.
 * A naive `await fetch(); setState(result)` then has a real bug: the requests
 * can resolve OUT OF ORDER, so an earlier (now-stale) response lands after a
 * newer one and clobbers it — the classic symptom being a value that flickers
 * back to an old state for a moment.
 *
 * This hook makes that impossible: each `refresh()` takes a monotonic ticket,
 * and a result is applied ONLY if its ticket is still the latest at resolution
 * time. Late responses are dropped, not shown. Results after unmount are
 * dropped too. The fetcher is read through a ref so an inline closure doesn't
 * re-identify `refresh` on every render.
 */
export function useLiveResource<T>(fetcher: () => Promise<T>): {
  value: T | null;
  error: boolean;
  loading: boolean;
  refresh: () => void;
} {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const ticket = useRef(0);
  const alive = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    const mine = ++ticket.current;
    void fetcherRef
      .current()
      .then((v) => {
        // Only the latest in-flight request may write — an older one that
        // resolves later is discarded rather than clobbering fresh data.
        if (alive.current && mine === ticket.current) {
          setValue(v);
          setError(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive.current && mine === ticket.current) {
          setError(true);
          setLoading(false);
        }
      });
  }, []);

  return { value, error, loading, refresh };
}
