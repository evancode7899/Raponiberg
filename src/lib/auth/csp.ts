/**
 * The Content-Security-Policy every response carries (next.config.ts): what a page may load
 * and where it may send anything. All of it is this app's own address, so the promise that
 * your data never leaves the computer is one the browser itself enforces: a script that
 * tried to send a figure anywhere else (a bad dependency, an injected tag) is refused.
 *
 * Scripts and styles may be inline, because Next.js starts each page with inline scripts and
 * the charts set inline styles. The dev server also needs eval and its reload socket.
 */
export function contentSecurityPolicy(dev: boolean, { framedBySelf = false }: { framedBySelf?: boolean } = {}): string {
  const self = "'self'";
  const directives: Record<string, string[]> = {
    "default-src": [self],
    "script-src": [self, "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": [self, "'unsafe-inline'"],
    "img-src": [self, "data:", "blob:"],
    "font-src": [self],
    "connect-src": [self, ...(dev ? ["ws://127.0.0.1:*", "ws://localhost:*"] : [])],
    // A saved receipt opens as a blob in the browser's own PDF viewer.
    "object-src": [self, "blob:"],
    "frame-src": [self, "blob:"],
    "base-uri": [self],
    "form-action": [self],
    // No page may be framed, except by the app itself for the split view (securityHeaders below: only a
    // request the browser marks as a same-origin frame gets this).
    "frame-ancestors": [framedBySelf ? self : "'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

/**
 * The response headers that keep pages out of other sites' frames (next.config.ts). Every
 * page refuses all framing, except a request the browser itself marks as this same app framing
 * one of its own pages (Sec-Fetch-Dest: iframe, Sec-Fetch-Site: same-origin): the split view.
 * A page on another host can't set those headers, so it can still frame nothing.
 * Next.js applies matching rules in order and the last one wins, so the split pane's rule
 * comes second.
 */
export const SELF_FRAME_REQUEST = [
  { type: "header" as const, key: "sec-fetch-dest", value: "iframe" },
  { type: "header" as const, key: "sec-fetch-site", value: "same-origin" },
];

export function securityHeaders(dev: boolean) {
  const fixed = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
  ];
  return [
    {
      source: "/:path*",
      headers: [{ key: "Content-Security-Policy", value: contentSecurityPolicy(dev) }, { key: "X-Frame-Options", value: "DENY" }, ...fixed],
    },
    {
      source: "/:path*",
      has: SELF_FRAME_REQUEST,
      headers: [{ key: "Content-Security-Policy", value: contentSecurityPolicy(dev, { framedBySelf: true }) }, { key: "X-Frame-Options", value: "SAMEORIGIN" }],
    },
  ];
}

/** Whether a request's headers are a same-origin frame request (the split view), as SELF_FRAME_REQUEST matches them. */
export function framedBySelf(h: Headers): boolean {
  return SELF_FRAME_REQUEST.every((c) => h.get(c.key) === c.value);
}
