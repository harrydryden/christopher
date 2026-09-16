import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Silkscreen } from "next/font/google";
import "./globals.css";

// Silkscreen for headings, labels and the numerals beside the mark; Plex Mono
// for everything else. next/font self-hosts both, so there is no render-blocking
// request to Google and no flash of the fallback stack.
const pixel = Silkscreen({
  weight: ["400", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-pixel-family",
});

const mono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono-family",
});

export const metadata: Metadata = {
  title: "Christopher",
  description: "Careers page monitor",
  // favicon.ico, icon.svg and apple-icon.png live in app/ and Next links them
  // automatically; the manifest comes from app/manifest.ts.
  manifest: "/manifest.webmanifest",
  appleWebApp: { title: "Christopher" },
};

export const viewport: Viewport = {
  // The ground colour. The mark is white on black at every size.
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${pixel.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
