import type { Metadata, Viewport } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

/**
 * The two faces of `docs/design/design-system.md` §2, loaded through `next/font`.
 *
 * `next/font` self-hosts them at build time, so a person opening Weathra makes no request to a
 * font CDN — which matters here for the same reason the privacy stance in `docs/privacy-ethics.md`
 * matters: a third-party request on every page load is a third party learning who reads Weathra
 * and when. Each face exposes a CSS variable that `globals.css` puts behind a family token, so a
 * component names a *role* and never a font.
 */
const display = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

const body = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  // Each destination sets its own title and this frames it, so a browser tab and a bookmark say
  // which screen they are rather than all saying "Weathra".
  title: { default: "Weathra", template: "%s · Weathra" },
  description: "Agentic weather intelligence, forecast analysis, and analytics",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
