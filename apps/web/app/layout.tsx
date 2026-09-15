import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Christopher",
  description: "Careers page monitor",
  // favicon.ico, icon.svg and apple-icon.png live in app/ and Next links them
  // automatically; the manifest comes from app/manifest.ts.
  manifest: "/manifest.webmanifest",
  appleWebApp: { title: "Christopher" },
};

export const viewport: Viewport = {
  // Follows the black accent, so the tab matches the app chrome.
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
