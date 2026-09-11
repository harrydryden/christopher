import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Christopher",
    short_name: "Christopher",
    description: "Careers page monitor",
    start_url: "/",
    display: "standalone",
    // Slate is the product accent in BRAND.md and matches the favicon drum, so
    // the installed app's chrome reads as the same brand as the tab.
    background_color: "#f4f1ea",
    theme_color: "#2f5678",
    icons: [
      { src: "/brand/favicon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/favicon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
