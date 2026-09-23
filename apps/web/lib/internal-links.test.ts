/**
 * Moving between pages of the interface is a client navigation: `next/link` renders only the
 * segment that changed, where a plain anchor reloads the document and runs the session, the
 * sidebar's count and the scan banner again. Anchors stay for what leaves the interface: another
 * site in a new tab, or a download from `/api/`.
 */
import { readFile } from "node:fs/promises";
import Link from "next/link";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, it } from "vitest";
import { Pagination } from "@/components/Pagination";

/** Every element in a rendered tree that carries an `href`. */
function linksIn(node: ReactNode): ReactElement<{ href: string }>[] {
  if (Array.isArray(node)) return node.flatMap(linksIn);
  if (!isValidElement(node)) return [];
  const props = node.props as { href?: unknown; children?: ReactNode };
  return [...(typeof props.href === "string" ? [node as ReactElement<{ href: string }>] : []), ...linksIn(props.children)];
}

it("pages through a list with client navigations", () => {
  const links = linksIn(Pagination({ page: 2, total: 200, path: "/companies", params: { q: "acme" } }));
  expect(links.map((link) => link.props.href)).toEqual(["/companies?q=acme&page=1", "/companies?q=acme&page=3"]);
  expect(links.every((link) => link.type === Link)).toBe(true);
});

const FILES = [
  "components/Pagination.tsx",
  "components/RolesTable.tsx",
  "components/RoleWorkspace.tsx",
  "app/(app)/companies/page.tsx",
  "app/(app)/companies/[id]/page.tsx",
  "app/(app)/admin/page.tsx",
];

it("links within the interface with next/link, never a plain anchor", async () => {
  // In these files an anchor either opens another site in a new tab or downloads from `/api/`.
  for (const file of FILES) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const internal = [...source.matchAll(/<a\s[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => !tag.includes('target="_blank"') && !/href=(\{`|")\/api\//.test(tag));
    expect(internal, file).toEqual([]);
  }
});
