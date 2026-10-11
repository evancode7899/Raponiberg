import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The desktop launcher builds into a staging folder (NEXT_BUILD_DIR) and only swaps it
  // into .next when the build succeeds, so a broken build never takes away the last
  // working version of the app.
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  // pdf-parse and pdf.js break when bundled ("Object.defineProperty called on non-object",
  // first seen under webpack); load them from node_modules at runtime instead. Proven under
  // Turbopack (the build default) by re-reading a real statement of every parser's kind.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
  // Integrity moved into Statements (the Issues tab); old links and bookmarks land there.
  async redirects() {
    return [{ source: "/integrity", destination: "/statements?tab=issues", permanent: false }];
  },
  experimental: {
    optimizePackageImports: ["recharts"],
  },
  turbopack: {
    // The data stores read files under data/ (DATA_DIR) at run time, a path the build can't
    // see; Turbopack warns that this traces the whole project, which only matters for a
    // size-limited cloud deployment. Raponiberg runs locally from its own folder.
    ignoreIssue: [{ path: "**", title: /Dynamic filesystem access causes tracing of the whole project/ }],
  },
  // Next.js 16.2+ otherwise writes a managed block into AGENTS.md whenever `next dev`
  // detects an AI coding agent. AGENTS.md carries the license rules and stays the owner's
  // alone, and an edited tracked file would also block the launcher's updates.
  agentRules: false,
};

export default nextConfig;
