import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addReimbursementLink, readReimbursementLinks, removeReimbursementLink } from "./store";

const tempFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "reimbursement-links-")), "reimbursement-links.json");

const charge = { institution: "Example Card Co", identifiers: ["5678"], date: "2026-02-03", amountCents: -4_321, payee: "springfield garage" };
const stub = { kind: "stub" as const, stub: { employerKey: "EXAMPLE PARTNERS LP", payDate: "2026-02-27", line: "Expense Reimb", cents: 9_999 } };

describe("reimbursement links file", () => {
  it("adds and removes links, journaling each change", () => {
    const file = tempFile();
    expect(readReimbursementLinks(file).links).toEqual([]);
    const a = addReimbursementLink({ expense: charge, source: stub, cents: 4_321, note: "  parking  " }, file);
    addReimbursementLink({ expense: { ...charge, date: "2026-02-10" }, source: stub, cents: 1_000, note: "" }, file);
    const links = readReimbursementLinks(file).links;
    expect(links.map((l) => [l.cents, l.note])).toEqual([
      [4_321, "parking"],
      [1_000, null],
    ]);
    expect(removeReimbursementLink(a.id, file)).toBe(true);
    expect(removeReimbursementLink(a.id, file)).toBe(false);
    expect(readReimbursementLinks(file).links).toHaveLength(1);
    const journal = file.replace(/\.json$/, ".journal.jsonl");
    expect(existsSync(journal) && readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l).op)).toEqual(["link", "link", "unlink"]);
  });

  it("refuses an amount of $0 or less", () => {
    expect(() => addReimbursementLink({ expense: charge, source: stub, cents: 0, note: null }, tempFile())).toThrow(/more than \$0/);
  });

  it("treats a damaged or newer file as an error, never as no links", () => {
    const bad = tempFile();
    writeFileSync(bad, "{ not json");
    expect(() => readReimbursementLinks(bad)).toThrow(/damaged/);
    const newer = tempFile();
    writeFileSync(newer, JSON.stringify({ version: 2, links: [] }));
    expect(() => readReimbursementLinks(newer)).toThrow(/newer version/);
  });
});
