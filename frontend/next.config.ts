import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The backend is a separate application on its own origin; Next.js never proxies to it and
  // never serves its routes. Its base URL is public configuration (NEXT_PUBLIC_API_BASE_URL).
  poweredByHeader: false,
  typedRoutes: false,
};

export default config;
