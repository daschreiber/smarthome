import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Home",
    short_name: "Home",
    description: "Private smart home control",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f2ee",
    theme_color: "#2f6b57",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
