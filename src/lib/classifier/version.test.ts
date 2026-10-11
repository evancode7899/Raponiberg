import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION, RULES_FINGERPRINT } from "./version";

describe("classifier version", () => {
  it("is bumped whenever the rules change", () => {
    const h = createHash("sha256");
    for (const f of ["classify.ts", "merchants.ts", "taxonomy.ts"]) {
      h.update(`${f}\n${readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n")}`);
    }
    const now = h.digest("hex").slice(0, 16);
    expect(
      now,
      `The classification rules changed. Bump CLASSIFIER_VERSION (now ${CLASSIFIER_VERSION}) in src/lib/classifier/version.ts and set RULES_FINGERPRINT to "${now}".`,
    ).toBe(RULES_FINGERPRINT);
  });
});
