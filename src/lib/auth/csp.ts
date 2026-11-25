/**
 * The Content-Security-Policy every response carries (next.config.ts): what a page may load
 * and where it may send anything. All of it is this app's own address, so the promise that
 * your data never leaves the computer is one the browser itself enforces: a script that
 * tried to send a figure anywhere else (a bad dependency, an injected tag) is refused.
 *
 * Scripts and styles may be inline, because Next.js starts each page with inline scripts and
 * the charts set inline styles. The dev server also needs eval and its reload socket.
 */
export function contentSecurityPolicy(dev: boolean): string {
  const self = "'self'";
  const directives: Record<string, string[]> = {
    "default-src": [self],
    "script-src": [self, "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": [self, "'unsafe-inline'"],
    "img-src": [self, "data:", "blob:"],
    "font-src": [self],
    "connect-src": [self, ...(dev ? ["ws://127.0.0.1:*", "ws://localhost:*"] : [])],
    "object-src": [self],
    "base-uri": [self],
    "form-action": [self],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}
