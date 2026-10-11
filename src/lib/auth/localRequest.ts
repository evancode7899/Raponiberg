/**
 * Whether a request really comes from this computer's own browser tab. The server binds to
 * 127.0.0.1, but that alone doesn't stop a website open in the same browser from reaching
 * it:
 *   - DNS rebinding: a site points its own domain at 127.0.0.1 and reads the app's pages
 *     and API as if it were the app. Its requests carry its own name in Host.
 *   - Cross-site requests: any page can send a "simple" POST (text/plain, no preflight) to
 *     127.0.0.1:3000, or load an API URL as an <img> or <script>. These carry the page's
 *     Origin, or Sec-Fetch-Site: cross-site.
 * Scripts and the launcher (no Origin, Host 127.0.0.1) still pass.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** "127.0.0.1:3000" → "127.0.0.1"; "[::1]:3000" → "[::1]". */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

function isLoopbackHost(host: string | null): boolean {
  return host != null && LOOPBACK_HOSTNAMES.has(hostnameOf(host));
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.host);
  } catch {
    return false; // includes "null" (sandboxed frames, file:// pages)
  }
}

export type RequestHeaders = { get(name: string): string | null };

/** Why the request is refused, or null when it may go through. */
export function rejectNonLocalRequest(pathname: string, headers: RequestHeaders): string | null {
  if (!isLoopbackHost(headers.get("host"))) return "Host is not this computer";
  const origin = headers.get("origin");
  if (origin != null && !isLoopbackOrigin(origin)) return "Request came from another website";
  // Pages stay reachable from links on other sites (that's a plain navigation, and DNS
  // rebinding is already stopped by Host); the API is for the app's own pages only.
  if (pathname.startsWith("/api/") && headers.get("sec-fetch-site") === "cross-site") return "Request came from another website";
  return null;
}
