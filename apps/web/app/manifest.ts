import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Christopher",
    short_name: "Christopher",
    description: "Careers page monitor",
    start_url: "/",
    display: "standalone",
    // Brand Slate matches the favicon drum and reads better than the deep navy
    // accent at icon size, so the installed app and the tab agree.
    background_color: "#f4f1ea",
    theme_color: "#2f5678",
    icons: [
      { src: "/brand/favicon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/favicon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
