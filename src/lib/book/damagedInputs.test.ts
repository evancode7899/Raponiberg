import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readProfileSettings } from "../profile/settings";
import { readTaxProfile } from "../tax/profile";
import { readTaxDocsChecked } from "../taxdocs/store";

// SSOT F · G: a damaged input is reported, never read as its defaults or as "nothing saved".
const dbWith = (value: string | null) => ({ appSetting: { findUnique: async () => (value == null ? null : { value }) } }) as never;

describe("damaged inputs", () => {
  it("the tax profile says why it can't be read", async () => {
    expect((await readTaxProfile(dbWith(null))).error).toBeUndefined();
    const r = await readTaxProfile(dbWith("{not json"));
    expect(r.error).toMatch(/tax profile/);
    expect(r.profile.persons).toBeDefined();
  });

  it("the profile settings say why they can't be read", async () => {
    expect((await readProfileSettings(dbWith("{}"))).error).toBeUndefined();
    expect((await readProfileSettings(dbWith("]"))).error).toMatch(/profile settings/);
  });

  it("the tax documents scan tells damaged apart from never scanned", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "taxdocs-"));
    expect(readTaxDocsChecked(path.join(dir, "missing.json"))).toEqual({ docs: null });
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{");
    expect(readTaxDocsChecked(bad).error).toMatch(/can't be read/);
    const listless = path.join(dir, "listless.json");
    writeFileSync(listless, "{}");
    expect(readTaxDocsChecked(listless).error).toMatch(/no list/);
  });
});
