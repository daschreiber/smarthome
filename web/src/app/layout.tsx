import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Home",
  description: "Private smart home control",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0f14",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#0b0f14",
          color: "#e8edf2",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
