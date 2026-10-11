import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The desktop launcher builds into a staging folder (NEXT_BUILD_DIR) and only swaps it
  // into .next when the build succeeds, so a broken build never takes away the last
  // working version of the app.
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  // pdf-parse and pdf.js break when webpack bundles them ("Object.defineProperty called on
  // non-object"); load them from node_modules at runtime instead.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
  // Integrity moved into Statements (the Issues tab); old links and bookmarks land there.
  async redirects() {
    return [{ source: "/integrity", destination: "/statements?tab=issues", permanent: false }];
  },
  experimental: {
    optimizePackageImports: ["recharts"],
  },
};

export default nextConfig;
