import { useEffect, useRef, useState } from 'react';
import { BffError } from './client';

export interface Async<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  /** The BFF answered 403: the caller's Clearance level does not allow this read. */
  forbidden: boolean;
}

/**
 * Runs `fn` whenever `key` changes; the latest call wins. `key: null` runs nothing (a read
 * that waits for something else). A 403 sets `forbidden`, so the page can say what is hidden.
 */
export function useBff<T>(fn: () => Promise<T>, key: string | null): Async<T> {
  const [result, setResult] = useState<{ key: string | null; data?: T; error?: Error }>({ key: null });
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    if (key === null) {
      return;
    }
    let live = true;
    fnRef.current().then(
      (data) => live && setResult({ key, data }),
      (error: unknown) => live && setResult({ key, error: error instanceof Error ? error : new Error(String(error)) })
    );
    return () => {
      live = false;
    };
  }, [key]);
  const settled = key !== null && result.key === key;
  const error = settled ? result.error : undefined;
  return {
    data: settled ? result.data : undefined,
    error,
    loading: key !== null && !settled,
    forbidden: error instanceof BffError && error.forbidden,
  };
}
