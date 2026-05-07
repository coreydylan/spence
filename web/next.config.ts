import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Cloudflare Pages via @opennextjs/cloudflare doesn't need experimental flags here.
  // The opennextjs adapter handles the runtime adaptation at build time.
  experimental: {
    // Tailwind v4 ships ESM-only utilities; nothing else needed for now.
  },
};

export default nextConfig;
