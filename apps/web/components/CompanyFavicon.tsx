"use client";

import { useEffect, useState } from "react";
import { iconCandidates } from "@/lib/company-icon";

/**
 * A company icon that never shows a broken image.
 *
 * The worker stores an icon URL when it can read the company's site. Bot-protected sites
 * (hims.com answers 403 to anything that is not a browser) leave it empty, or hand over an
 * unverified `/favicon.ico` guess. So the browser, which those sites do let in, walks a chain:
 * the stored URL, then the site's own `/favicon.ico`, then a public icon service keyed by
 * domain. Each miss steps silently to the next; the last miss leaves the placeholder square.
 *
 * A roles page carries fifty of these, most below the fold, so they load lazily and decode off
 * the main thread. Width and height are set, so nothing moves when one arrives, and an icon that
 * fails still steps down the chain when the browser gets to it.
 */
export function CompanyFavicon({ src, domain, size = 16 }: { src: string | null; domain?: string | null; size?: number }) {
  const candidates = iconCandidates(src, domain);
  const [index, setIndex] = useState(0);
  // A different company in the same slot starts the chain again.
  useEffect(() => { setIndex(0); }, [src, domain]);
  const url = candidates[index];
  if (!url) return <span className="inline-block shrink-0 bg-track" style={{ width: size, height: size }} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={url}
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="shrink-0"
      onError={() => setIndex((i) => i + 1)}
    />
  );
}
