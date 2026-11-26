import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, framedBySelf, securityHeaders, SELF_FRAME_REQUEST } from "./csp";

const parse = (dev: boolean) => Object.fromEntries(contentSecurityPolicy(dev).split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1)]));

describe("content security policy", () => {
  it("lets a page talk to this app's own address and nowhere else", () => {
    const p = parse(false);
    expect(p["connect-src"]).toEqual(["'self'"]);
    expect(p["form-action"]).toEqual(["'self'"]);
    expect(p["default-src"]).toEqual(["'self'"]);
    expect(p["frame-ancestors"]).toEqual(["'none'"]);
    expect(contentSecurityPolicy(false)).not.toMatch(/https?:|\*|unsafe-eval|wss?:/);
  });

  it("lets the app frame only itself, and only for a same-origin frame request", () => {
    const framed = Object.fromEntries(contentSecurityPolicy(false, { framedBySelf: true }).split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1)]));
    expect(framed["frame-ancestors"]).toEqual(["'self'"]);
    // Everything else is as strict as the unframed page.
    expect({ ...framed, "frame-ancestors": null }).toEqual({ ...parse(false), "frame-ancestors": null });
    expect(framedBySelf(new Headers({ "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(framedBySelf(new Headers({ "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(framedBySelf(new Headers({ "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site" }))).toBe(false);
    expect(framedBySelf(new Headers({ "sec-fetch-dest": "document", "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(framedBySelf(new Headers())).toBe(false);
  });

  it("denies framing to every page first, and the self-frame rule comes last so it wins only when it matches", () => {
    const [all, self] = securityHeaders(false);
    expect(all!.has).toBeUndefined();
    expect(all!.headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    expect(all!.headers.find((h) => h.key === "Content-Security-Policy")!.value).toContain("frame-ancestors 'none'");
    expect(self!.has).toEqual(SELF_FRAME_REQUEST);
    expect(self!.headers).toContainEqual({ key: "X-Frame-Options", value: "SAMEORIGIN" });
  });

  it("opens only the dev server's own needs in dev", () => {
    const p = parse(true);
    expect(p["script-src"]).toContain("'unsafe-eval'");
    expect(p["connect-src"]!.every((s) => s === "'self'" || /^ws:\/\/(127\.0\.0\.1|localhost):\*$/.test(s))).toBe(true);
  });
});
