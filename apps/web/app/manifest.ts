import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Course of Life",
    short_name: "Course of Life",
    description: "Find your path.",
    start_url: "/",
    display: "standalone",
    // The brand green (--brand-green in globals.css). The installed app and the
    // tab agree: the Course of Life mark, a point with three paths leaving it, in
    // green on white (light green on green for the maskable icon).
    background_color: "#25593a",
    theme_color: "#25593a",
    icons: [
      { src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/app-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
