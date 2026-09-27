/**
 * Compiles the worker ahead of time for its image: `src/index.ts` and the workspace packages it
 * imports (`@ava/*`, which ship TypeScript) into one ES module, `dist/index.mjs`, which the image
 * runs with plain `node`. Running from source under `tsx` kept the transpiler and its esbuild child
 * in the process for its whole life (docs/DEPLOY.md). Tests and the CLI still run from source with
 * `tsx`.
 *
 * The worker's own dependencies stay external and are loaded from its node_modules as before:
 * several carry native code or files of their own (pg, sharp, playwright, pdf-parse). A package
 * only a workspace package depends on (zod, the Anthropic SDK) is not reachable from the worker's
 * node_modules under pnpm's strict layout, so it is bundled from where that package resolves it.
 *
 * Tracing (src/otel.ts) is built as a second module, `dist/otel.mjs`, and preloaded with
 * `--import ./dist/otel.mjs` before the bundle, as the source entry preloads src/otel.ts: the pg and
 * undici instrumentations must be in place before either package is first loaded, and the bundle
 * loads pg at its top. The bundle imports `./otel.mjs` rather than carrying its own copy, so the
 * preload and the bundle share one module and one SDK.
 *
 * The migrator finds its SQL next to its own source (`new URL("../drizzle", import.meta.url)` in
 * packages/db/src/migrate.ts). Bundled, that module's URL is the bundle's, so the folder is copied
 * to `dist/drizzle` and that one expression is pointed at it; the build fails if the expression
 * is not found, rather than producing a worker that cannot migrate.
 */
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { cp, readFile, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_URL = 'new URL("../drizzle", import.meta.url)';

/** The package a bare specifier names: `pg` for `pg/lib/x`, `@scope/name` for `@scope/name/sub`. */
function packageName(specifier) {
  return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

await rm(`${here}dist`, { recursive: true, force: true });

const OTEL_SOURCE = resolve(here, "src/otel.ts");

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  logLevel: "warning",
  // Bundled CommonJS helpers call `require`; an ES module has none unless it is made.
  banner: { js: 'import { createRequire as __avaCreateRequire } from "node:module"; const require = __avaCreateRequire(import.meta.url);' },
};

const externalDependencies = {
  name: "external-worker-dependencies",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path.startsWith("@ava/")) return undefined;
      const name = packageName(args.path);
      if (args.path.startsWith("node:") || isBuiltin(name) || existsSync(`${here}node_modules/${name}`)) return { path: args.path, external: true };
      return undefined;
    });
  },
};

await build({ ...common, entryPoints: [OTEL_SOURCE], outfile: `${here}dist/otel.mjs`, plugins: [externalDependencies] });

await build({
  ...common,
  entryPoints: [`${here}src/index.ts`],
  outfile: `${here}dist/index.mjs`,
  plugins: [
    {
      name: "shared-otel",
      setup(b) {
        // The preloaded tracing module, not a second copy of it.
        b.onResolve({ filter: /(^|\/)otel$/ }, args =>
          resolve(args.resolveDir, `${args.path}.ts`) === OTEL_SOURCE ? { path: "./otel.mjs", external: true } : undefined);
      },
    },
    externalDependencies,
    {
      name: "bundled-migrations",
      setup(b) {
        b.onLoad({ filter: /packages[\\/]db[\\/]src[\\/]migrate\.ts$/ }, async args => {
          const source = await readFile(args.path, "utf8");
          if (!source.includes(MIGRATIONS_URL)) throw new Error(`${args.path} no longer reads its migrations from ${MIGRATIONS_URL}; update build.mjs`);
          return { contents: source.replace(MIGRATIONS_URL, 'new URL("./drizzle", import.meta.url)'), loader: "ts" };
        });
      },
    },
  ],
});

await cp(`${here}../../packages/db/drizzle`, `${here}dist/drizzle`, { recursive: true });
console.log("built dist/index.mjs and dist/otel.mjs");
