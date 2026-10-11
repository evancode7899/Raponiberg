import { describe, expect, it } from "vitest";
import { rejectNonLocalRequest } from "./localRequest";

const headers = (h: Record<string, string>) => new Headers(h);

describe("rejectNonLocalRequest", () => {
  it("lets the app's own tab, scripts and the launcher through", () => {
    expect(rejectNonLocalRequest("/", headers({ host: "127.0.0.1:3000" }))).toBeNull();
    expect(rejectNonLocalRequest("/api/dashboard", headers({ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(rejectNonLocalRequest("/api/system/shutdown", headers({ host: "[::1]:3000" }))).toBeNull();
    // The demo (port 3001) and the real app are the same site.
    expect(rejectNonLocalRequest("/api/app-password", headers({ host: "127.0.0.1:3001", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-site" }))).toBeNull();
  });

  it("refuses a rebound domain (DNS rebinding)", () => {
    expect(rejectNonLocalRequest("/api/export/transactions", headers({ host: "evil.example:3000" }))).toMatch(/Host/);
    expect(rejectNonLocalRequest("/", headers({ host: "127.0.0.1.evil.example" }))).toMatch(/Host/);
    expect(rejectNonLocalRequest("/", headers({}))).toMatch(/Host/);
  });

  it("refuses requests another website sends", () => {
    const local = { host: "127.0.0.1:3000" };
    expect(rejectNonLocalRequest("/api/settings/database/wipe", headers({ ...local, origin: "https://evil.example" }))).toMatch(/another website/);
    expect(rejectNonLocalRequest("/api/settings/database/wipe", headers({ ...local, origin: "null" }))).toMatch(/another website/);
    expect(rejectNonLocalRequest("/api/export/transactions", headers({ ...local, "sec-fetch-site": "cross-site" }))).toMatch(/another website/);
  });

  it("still opens pages from a link on another site", () => {
    expect(rejectNonLocalRequest("/dashboard", headers({ host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" }))).toBeNull();
  });
});
