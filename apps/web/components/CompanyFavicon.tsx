"use client";

/**
 * A company icon that disappears rather than showing a broken image. Some
 * icon URLs are handed over unverified — the worker could not read a
 * bot-protected site but the browser usually can — so a miss must be silent.
 */
export function CompanyFavicon({ src, size = 16 }: { src: string | null; size?: number }) {
  if (!src) return <span className="inline-block shrink-0 bg-track" style={{ width: size, height: size }} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      className="shrink-0"
      onError={(e) => { e.currentTarget.replaceWith(Object.assign(document.createElement("span"), { className: "inline-block shrink-0 bg-track", style: `width:${size}px;height:${size}px` })); }}
    />
  );
}
