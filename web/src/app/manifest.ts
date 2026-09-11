import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Taymna",
    short_name: "Taymna",
    description: "Give a computer time. When the time is up, make it unavailable.",
    start_url: "/",
    display: "standalone",
    background_color: "#1c1815",
    theme_color: "#1c1815",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
