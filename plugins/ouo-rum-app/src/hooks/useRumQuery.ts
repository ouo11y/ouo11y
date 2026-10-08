import { useCallback, useEffect, useRef, useState } from 'react';
import { RumApiError } from '../api/client';

export interface QueryState<T> {
  data: T | undefined;
  error: RumApiError | undefined;
  loading: boolean;
  reload: () => void;
}

interface Result<T> {
  key: string;
  data?: T;
  error?: RumApiError;
}

/**
 * Runs an async rum-api call whenever `key` changes (or `reload` is called); the latest
 * call wins. Previous data stays visible while a new request is in flight.
 */
export function useRumQuery<T>(fetcher: () => Promise<T>, key: string, enabled = true): QueryState<T> {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<Result<T>>({ key: '' });
  const fetcherRef = useRef(fetcher);
  const requestKey = `${key}#${tick}`;

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    fetcherRef
      .current()
      .then((data) => {
        if (!cancelled) {
          setResult({ key: requestKey, data });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult((prev) => ({
            key: requestKey,
            data: prev.data,
            error: err instanceof RumApiError ? err : new RumApiError(String(err), ''),
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const settled = result.key === requestKey;
  return {
    data: enabled ? result.data : undefined,
    error: settled ? result.error : undefined,
    loading: enabled && !settled,
    reload,
  };
}
