import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AVA",
    short_name: "AVA",
    description: "Careers page monitor",
    start_url: "/",
    display: "standalone",
    // The brand green (--brand-green in globals.css). The installed app and the
    // tab agree: the monogram, a green triangle with a light-green A.
    background_color: "#25593a",
    theme_color: "#25593a",
    icons: [
      { src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/app-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
