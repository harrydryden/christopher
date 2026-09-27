/**
 * Every weight next/font is asked for is a woff2 preloaded on every hard load, `/login` included.
 * Silkscreen's bold was one such file that nothing painted: `ds-pixel` pins 400. And Plex Mono's
 * generated fallback was Arial stretched by `size-adjust`, which moved line breaks and tabular
 * figures when the real face swapped in; a system monospace advances within a percent of Plex.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const layout = readFileSync(path.join(WEB, "app/layout.tsx"), "utf8");
const call = (name: string) => layout.match(new RegExp(`${name}\\(\\{([\\s\\S]*?)\\}\\);`))?.[1] ?? "";

it("loads the pixel face at its one painted weight", () => {
  expect(call("Silkscreen")).toMatch(/weight:\s*\["400"\]/);
});

it("falls back from Plex Mono to a monospace stack, not a size-adjusted Arial", () => {
  const mono = call("IBM_Plex_Mono");
  expect(mono).toMatch(/adjustFontFallback:\s*false/);
  expect(mono).toMatch(/fallback:\s*\["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"\]/);
});
