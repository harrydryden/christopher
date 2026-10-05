import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Silkscreen } from "next/font/google";
import "./globals.css";

// Silkscreen for headings, labels and the numerals beside the mark; Plex Mono
// for everything else. next/font self-hosts both, so there is no render-blocking
// request to Google and no flash of the fallback stack.
//
// Silkscreen at 400 only: `ds-pixel` pins that weight, so a bold face would be a
// preload every hard load pays for and nothing paints. A pixel element in a bold
// context (a <th>, a <strong>) carries `ds-pixel` itself, as the table's TH does.
const pixel = Silkscreen({
  weight: ["400"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-pixel-family",
});

// While Plex loads, a monospace stand-in rather than Arial stretched to fit: the
// system monospaces advance within a percent of Plex's 600/1000 em, so line
// breaks and tabular figures hold when the real face swaps in.
const mono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono-family",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"],
});

export const metadata: Metadata = {
  title: "Course of Life",
  description: "Find your path.",
  // favicon.ico, icon.svg and apple-icon.png live in app/ and Next links them
  // automatically; the manifest comes from app/manifest.ts.
  manifest: "/manifest.webmanifest",
  appleWebApp: { title: "Course of Life" },
};

export const viewport: Viewport = {
  // The brand green: the sidebar and the favicon's mark. A viewport colour
  // cannot read a CSS custom property, so this literal mirrors --brand-green in
  // globals.css.
  themeColor: "#25593a",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${pixel.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
