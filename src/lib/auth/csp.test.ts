import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./csp";

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

  it("opens only the dev server's own needs in dev", () => {
    const p = parse(true);
    expect(p["script-src"]).toContain("'unsafe-eval'");
    expect(p["connect-src"]!.every((s) => s === "'self'" || /^ws:\/\/(127\.0\.0\.1|localhost):\*$/.test(s))).toBe(true);
  });
});
