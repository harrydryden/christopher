import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Christopher",
    short_name: "Christopher",
    description: "Careers page monitor",
    start_url: "/",
    display: "standalone",
    // Follows the black accent so the installed app and the in-app chrome
    // agree. Paper stays as the splash background behind the mark.
    background_color: "#f4f1ea",
    theme_color: "#000000",
    icons: [
      { src: "/brand/favicon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/favicon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
