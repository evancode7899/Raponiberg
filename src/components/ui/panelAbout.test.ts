import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DASHBOARD_KEYS } from "@/components/shell/shortcuts";
import { PANEL_ABOUT } from "./panelAbout";

describe("what each panel is", () => {
  const panels = readFileSync(path.join(process.cwd(), "src/app/dashboard/panels.tsx"), "utf8");
  const codes = [...new Set([...panels.matchAll(/<Panel\s+code="([A-Z]+)"/g)].map((m) => m[1]!))];

  it("covers every Dashboard panel", () => {
    expect(codes.length).toBeGreaterThan(5);
    for (const code of codes) expect(PANEL_ABOUT[code], code).toBeDefined();
  });

  it("is words only: no figures beside the panel's own proven ones", () => {
    for (const [code, a] of Object.entries(PANEL_ABOUT)) {
      for (const text of [a.what, a.from, a.use ?? ""]) expect(text, code).not.toMatch(/\$\s?\d|\d[\d,]*\.\d\d/);
    }
  });

  it("is listed with the Dashboard's keys", () => {
    expect(DASHBOARD_KEYS.map(([k]) => k)).toContain("I");
  });
});
