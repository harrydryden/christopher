/**
 * Loader hooks for the CV load harness's interface child (scripts/cv-load-web.mts).
 *
 * The harness calls the product's own server action (`requestCv`) and route handler
 * (`/api/work-status`) outside Next.js, the way `apps/web/app/actions/cv-e2e.test.ts` does under
 * Vitest's mocks. Three Next.js modules only mean something inside a request, so they are replaced:
 * `next/headers` reads the signed session cookie of the simulated request from an
 * AsyncLocalStorage the child installs on `globalThis.__cvLoad`, `next/cache` does nothing, and
 * `next/navigation`'s `redirect` throws an error carrying the URL, which is how the child learns the
 * draft id a request created. Everything else (authentication, the account's build cap, the role
 * lock, the draft, the task row) is the product's code.
 *
 * Imported with `node --import`; it registers itself on the main thread and serves as the hooks
 * module on the loader thread.
 */
import { isMainThread } from 'node:worker_threads';
import { register } from 'node:module';

const HEADERS = `
export async function cookies() {
  const value = globalThis.__cvLoad?.cookie?.();
  return {
    get: (name) => (value && name === 'ava_session' ? { name, value } : undefined),
    getAll: () => (value ? [{ name: 'ava_session', value }] : []),
    has: (name) => !!value && name === 'ava_session',
    set() {}, delete() {},
  };
}
export async function headers() {
  return new Headers({ host: '127.0.0.1', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'http' });
}
export async function draftMode() { return { isEnabled: false, enable() {}, disable() {} }; }
`;
const CACHE = `
export function revalidatePath() {}
export function revalidateTag() {}
export function unstable_cache(fn) { return fn; }
export function unstable_noStore() {}
`;
const NAVIGATION = `
export class CvLoadRedirect extends Error {
  constructor(url) { super('NEXT_REDIRECT:' + url); this.url = url; this.digest = 'NEXT_REDIRECT;replace;' + url + ';307;'; }
}
export function redirect(url) { throw new CvLoadRedirect(url); }
export function permanentRedirect(url) { throw new CvLoadRedirect(url); }
export function notFound() { const e = new Error('NEXT_NOT_FOUND'); e.digest = 'NEXT_NOT_FOUND'; throw e; }
`;

export const STUBS = Object.freeze({ 'next/headers': HEADERS, 'next/cache': CACHE, 'next/navigation': NAVIGATION });

export async function resolve(specifier, context, nextResolve) {
  const source = STUBS[specifier] ?? STUBS[specifier.replace(/\.js$/, '')];
  if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, format: 'module', shortCircuit: true };
  return nextResolve(specifier, context);
}

if (isMainThread) register(import.meta.url);
