import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AVA",
    short_name: "AVA",
    description: "Careers page monitor",
    start_url: "/",
    display: "standalone",
    // The ground colour. The installed app and the tab agree: the monogram,
    // white on black, at every size.
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
