import type { FetchContext, FetchInit } from "@ava/core";

/** Carry one discovery run's deny-only host guard into every adapter verification request. */
export function guardedDiscoveryFetchContext(fetchCtx: FetchContext, allowHost?: FetchInit["allowHost"], onChallenge?: (error: unknown, requestedUrl: string) => void): FetchContext {
  if (!allowHost) return fetchCtx;
  const guard = (prior?: FetchInit["allowHost"]): NonNullable<FetchInit["allowHost"]> => async host => {
    await allowHost(host);
    await prior?.(host);
  };
  const observe = async <T>(url: string, work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) { onChallenge?.(error, url); throw error; }
  };
  return {
    ...fetchCtx,
    fetchText: (url, init) => observe(url, () => fetchCtx.fetchText(url, { ...init, allowHost: guard(init?.allowHost) })),
    fetchBytes: fetchCtx.fetchBytes ? (url, init) => observe(url, () => fetchCtx.fetchBytes!(url, { ...init, allowHost: guard(init?.allowHost) })) : undefined,
    render: fetchCtx.render ? (url, opts) => observe(url, () => fetchCtx.render!(url, { ...opts, allowHost: guard(opts?.allowHost) })) : undefined,
  };
}
