"use client";
import { startTransition, useCallback, useRef, useState } from "react";

export interface ActionCallOptions {
  /** The sentence a thrown action shows. Without one the error is rethrown: a redirect is how some actions refuse. */
  failed?: string;
  /** Asked before anything starts; a "no" starts nothing. */
  confirm?: string;
}

/**
 * Call a server action from a control and say how it went: whether a call is in flight (`busy`),
 * which one (`pending`, the key it was started with), and the sentence it failed with (`error`).
 * One call at a time, guarded by a ref, so a double click that lands before React re-renders the
 * disabled control still makes one call. The action decides what success means, and may set the
 * error from its own result.
 */
export function useActionCall<K = true>() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState<K | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((key: K, action: () => Promise<void>, { failed, confirm: question }: ActionCallOptions = {}) => {
    if (inFlight.current) return;
    if (question && !window.confirm(question)) return;
    inFlight.current = true;
    setPending(() => key);
    setError(null);
    startTransition(async () => {
      try {
        await action();
      } catch (thrown) {
        if (failed === undefined) throw thrown;
        setError(failed);
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    });
  }, []);
  return { busy: pending !== null, pending, error, setError, run };
}
