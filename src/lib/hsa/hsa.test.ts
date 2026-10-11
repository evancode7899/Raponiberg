import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { parseAmountCell, parseDateCell, parseDelimited, previewImport, sheetToExpenses } from "./importSheet.ts";
import { guessKind, qualifyPayee } from "./qualify.ts";
import { buildHsaReport, exactSubset, type LedgerRowIn, type ReportInput } from "./report.ts";
import { applyHsaOp, readHsaFile, type HsaExpense, type HsaFile } from "./store.ts";
import { excelSerialToIso, readXlsx } from "./xlsx.ts";

// ---------------------------------------------------------------------------- a minimal .xlsx

/** Zips the parts (deflated), enough for readXlsx: local headers, central directory, end record. */
function zip(parts: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const raw = Buffer.from(text, "utf8");
    const data = deflateRawSync(raw);
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** A workbook laid out like a hand-kept tracker: header in row 2 from column B, template rows, a total, a side calculation. */
function trackerXlsx(): Buffer {
  const strings = ["Date", "Amount", "Reimbursed?", "Provider/Notes", "Pat pharmacy refill", "Dr. Lee &amp; labs", "Kim physio", "Total Unreimbursed", "wages"];
  const s = (i: number) => `<c t="s"><v>${i}</v></c>`.replace("<c", `<c r="__"`);
  const cell = (ref: string, xml: string) => xml.replace("__", ref);
  const row = (n: number, cells: string[]) => `<row r="${n}">${cells.join("")}</row>`;
  const num = (ref: string, v: number) => `<c r="${ref}"><v>${v}</v></c>`;
  const sheet = [
    row(2, [cell("B2", s(0)), cell("C2", s(1)), cell("D2", s(2)), cell("E2", s(3))]),
    row(3, [num("B3", 45905), num("C3", 131.4), num("D3", 0), cell("E3", s(4))]), // 2025-09-05
    row(4, [num("B4", 45950), num("C4", 214.75), num("D4", 1), cell("E4", s(5))]), // 2025-10-20, reimbursed
    row(5, [num("B5", 46063), num("C5", 4125), num("D5", 0), cell("E5", s(6))]), // 2026-02-10
    row(6, [num("D6", 0)]),
    row(7, [num("D7", 0)]),
    row(8, [cell("B8", s(7)), `<c r="C8"><f>SUMIFS(C3:C7,D3:D7,0)</f><v>4256.4</v></c>`]),
    row(10, [cell("I10", s(8)), num("J10", 1000)]),
  ].join("");
  return zip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook><sheets><sheet name="HSA Expense List" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst>${strings.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
  });
}

describe("reading a receipts spreadsheet", () => {
  it("reads cells, shared strings, numbers and cached formula values from an .xlsx", () => {
    const [sheet] = readXlsx(trackerXlsx());
    expect(sheet!.name).toBe("HSA Expense List");
    expect(sheet!.rows[1]!.slice(1, 5)).toEqual(["Date", "Amount", "Reimbursed?", "Provider/Notes"]);
    expect(sheet!.rows[4]![4]).toBe("Kim physio");
    expect(sheet!.rows[7]![2]).toBe(4256.4);
    expect(excelSerialToIso(45905)).toBe("2025-09-05");
  });

  it("finds the columns by header and skips template rows, the total and side calculations", () => {
    const p = previewImport({ fileName: "tracker.xlsx", bytes: trackerXlsx() }, ["Pat Doe", "Kim Doe"]);
    expect(p.expenses.map((e) => [e.line, e.date, e.amountCents, e.reimbursed])).toEqual([
      [3, "2025-09-05", 13_140, false],
      [4, "2025-10-20", 21_475, true],
      [5, "2026-02-10", 412_500, false],
    ]);
    expect(p.expenses[1]!.provider).toBe("Dr. Lee & labs");
    // Patients from the household's first names; kind from the note.
    expect(p.expenses[0]!.patient).toBe("Pat Doe");
    expect(p.expenses[0]!.kind).toBe("PHARMACY");
    expect(p.expenses[2]).toMatchObject({ patient: "Kim Doe", kind: "THERAPY" });
    expect(p.skipped).toEqual([]);
  });

  it("reads CSV and cells pasted from Excel", () => {
    const tsv = parseDelimited("Date\tAmount\tReimbursed?\tProvider\n1/5/2026\t$1,204.50\tyes\tCity Hospital ER\n2/1/26\t40\t\tCVS\n");
    const p = sheetToExpenses(tsv);
    expect(p.expenses.map((e) => [e.date, e.amountCents, e.reimbursed, e.kind])).toEqual([
      ["2026-01-05", 120_450, true, "HOSPITAL"],
      ["2026-02-01", 4_000, false, "PHARMACY"],
    ]);
    const csv = parseDelimited('Service date,Cost,Notes,Reimbursed\n2026-03-04,"1,000.00","Smith, DDS",2026-05-01\n');
    expect(sheetToExpenses(csv).expenses[0]).toMatchObject({ date: "2026-03-04", amountCents: 100_000, provider: "Smith, DDS", reimbursed: true, reimbursedOn: "2026-05-01", kind: "DENTAL" });
  });

  it("parses the date and money spellings people type", () => {
    expect(parseDateCell("Feb 10, 2026")).toBe("2026-02-10");
    expect(parseDateCell("13/45/2026")).toBeNull();
    expect(parseDateCell(46063)).toBe("2026-02-10");
    expect(parseAmountCell("(22.00)")).toBe(2_200);
    expect(parseAmountCell("abc")).toBeNull();
  });

  it("explains a sheet with no usable header", () => {
    expect(() => previewImport({ text: "a,b\n1,2\n" })).toThrow(/header row/);
  });
});

describe("what counts as a qualified expense", () => {
  it("separates care from the medical-adjacent", () => {
    expect(qualifyPayee("SMILE BRIGHT DENTAL NEW YORK NY")).toMatchObject({ tier: "LIKELY", kind: "DENTAL" });
    expect(qualifyPayee("CVS/PHARMACY #01234")).toMatchObject({ tier: "CHECK", kind: "PHARMACY" });
    expect(qualifyPayee("LAKESIDE OPHTHALMOLOGY")).toMatchObject({ tier: "LIKELY", kind: "VISION" });
    expect(qualifyPayee("LABCORP")).toMatchObject({ tier: "LIKELY" });
    expect(qualifyPayee("EQUINOX FITNESS")).toBeNull();
    expect(qualifyPayee("AETNA PREMIUM")).toBeNull();
    expect(qualifyPayee("BANFIELD PET HOSPITAL")).toBeNull();
    expect(qualifyPayee("HILTON HOSPITALITY")).toBeNull();
    expect(qualifyPayee("SHELL 12 OAK DRIVE")).toBeNull();
    expect(qualifyPayee("MORGAN T")).toBeNull();
    expect(qualifyPayee("MORGAN T", null, true)).toMatchObject({ tier: "CHECK" });
  });

  it("guesses the kind from a note", () => {
    expect(guessKind("PT session and knee x-rays")).toBe("HOSPITAL");
    expect(guessKind("Epi pen CVS")).toBe("PHARMACY");
    expect(guessKind("Eye doc")).toBe("VISION");
    expect(guessKind("Dr. Morgan")).toBe("MEDICAL");
  });
});

// ---------------------------------------------------------------------------- report

const CARD = { id: "card", name: "Amex Gold", institution: "Amex", group: "Credit cards", identifiers: ["1001"] };
const HSA = { id: "hsa", name: "HealthEquity HSA", institution: "HealthEquity", group: "Health savings", identifiers: ["555"] };
let n = 0;
const row = (date: string, amountCents: number, payee: string, accountId = "card", extra: Partial<LedgerRowIn> = {}): LedgerRowIn => ({
  id: `r${++n}`,
  date,
  amountCents,
  lane: "EXPENSE",
  accountId,
  payee,
  merchantKey: payee,
  category: "Health & insurance",
  classifiedBy: "merchant-keyword",
  ...extra,
});
const expense = (id: string, date: string, amountCents: number, extra: Partial<HsaExpense> = {}): HsaExpense => ({
  id,
  date,
  amountCents,
  provider: id,
  patient: "",
  kind: "MEDICAL",
  notes: "",
  receipt: true,
  receiptRef: "",
  source: "IMPORT",
  paidWith: null,
  reimbursement: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});
const file = (expenses: HsaExpense[], patch: Partial<HsaFile> = {}): HsaFile => ({
  version: 1,
  expenses,
  dismissed: [],
  ignoredMerchants: [],
  settings: { openedOn: null, growthRate: 0.07, marginalRate: 0.35, planYear: 2046 },
  ...patch,
});
const input = (f: HsaFile, rows: LedgerRowIn[], extra: Partial<ReportInput> = {}): ReportInput => ({
  today: "2026-10-10",
  file: f,
  rows,
  accounts: [CARD, HSA],
  hsaAccounts: [{ name: "HealthEquity HSA", balanceCents: 2_000_000, asOf: "2026-09-30", annualizedReturn: 0.09 }],
  persons: ["Pat Doe"],
  marginalRate: null,
  ...extra,
});

describe("the HSA report", () => {
  it("ties logged expenses to the charge that paid them and suggests only the rest", () => {
    const rows = [
      row("2026-02-12", -412_500, "HARTLEY MD PC"), // the logged surgery, charged 2 days later
      row("2026-04-02", -71_500, "LAKESIDE OPHTHALMOLOGY"), // not logged: suggested
      row("2026-05-01", -2_500, "CVS/PHARMACY"), // drug store: check
      row("2026-06-01", -9_900, "EQUINOX"), // gym: never
      row("2026-07-01", -15_000, "CITYMD URGENT CARE"), // refunded below
      row("2026-07-20", 15_000, "CITYMD URGENT CARE"),
      row("2026-08-01", -50_000, "HEALTHEQUITY CARD SPEND", "hsa"), // paid from the HSA
    ];
    const r = buildHsaReport(input(file([expense("surgery", "2026-02-10", 412_500)]), rows));
    const surgery = r.expenses.find((e) => e.id === "surgery")!;
    expect(surgery.paid?.payee).toBe("HARTLEY MD PC");
    expect(surgery.paidAuto).toBe(true);
    expect(r.suggestions.map((s) => [s.payee, s.tier])).toEqual([
      ["LAKESIDE OPHTHALMOLOGY", "LIKELY"],
      ["CVS/PHARMACY", "CHECK"],
    ]);
  });

  it("doesn't guess between two equally close charges, but offers them to pick", () => {
    const rows = [row("2026-03-08", -4_000, "DR SMITH"), row("2026-03-12", -4_000, "DR SMITH")];
    const r = buildHsaReport(input(file([expense("visit", "2026-03-10", 4_000)]), rows));
    const v = r.expenses[0]!;
    expect(v.paid).toBeNull();
    expect(v.candidates).toHaveLength(2);
    // …and neither is suggested as a new expense either.
    expect(r.suggestions).toEqual([]);
  });

  it("leaves out dismissed charges, ignored merchants and anything before the HSA opened", () => {
    const rows = [row("2026-02-01", -10_000, "DR ONE"), row("2026-02-02", -20_000, "DR TWO"), row("2024-12-01", -30_000, "DR THREE")];
    const dismissed = [{ institution: "Amex", identifiers: ["1001"], date: "2026-02-01", amountCents: -10_000, payee: "DR ONE" }];
    const r = buildHsaReport(
      input(file([expense("old", "2024-11-01", 5_000)], { dismissed, ignoredMerchants: ["DR TWO"], settings: { openedOn: "2025-01-01", growthRate: null, marginalRate: null, planYear: null } }), rows),
    );
    expect(r.suggestions).toEqual([]);
    expect(r.expenses[0]!.flags).toContain("BEFORE_OPEN");
    expect(r.totals.unreimbursedCents).toBe(0);
    // Unset rates come from the HSA's measured return and the default bracket.
    expect(r.growth).toMatchObject({ rate: 0.09, rateSource: "MEASURED", marginalRate: 0.32, marginalSource: "DEFAULT", planYear: 2046 });
  });

  it("totals what's reimbursable, flags duplicates and missing receipts, and estimates growth from waiting", () => {
    const f = file([
      expense("a", "2025-10-10", 100_000),
      expense("b", "2026-02-10", 412_500, { receipt: false }),
      expense("c", "2026-02-10", 412_500),
      expense("d", "2025-09-01", 21_475, { reimbursement: { date: "2026-03-01", withdrawal: null, note: "" } }),
    ]);
    const r = buildHsaReport(input(f, []));
    expect(r.totals).toMatchObject({ count: 4, unreimbursedCents: 925_000, unreimbursedCount: 3, reimbursedCents: 21_475, readyCents: 512_500, missingReceiptCount: 1, oldestUnreimbursed: "2025-10-10" });
    expect(r.expenses.filter((e) => e.flags.includes("DUPLICATE")).map((e) => e.id).sort()).toEqual(["b", "c"]);
    // $1,000 waiting a year (365 of 365.25 days) at 7%.
    expect(r.expenses.find((e) => e.id === "a")!.growthCents).toBe(6_995);
    expect(r.years.find((y) => y.year === 2026)).toMatchObject({ count: 2, reimbursedInYearCents: 21_475 });
    // Paying out of pocket and waiting beats paying from the HSA now, which beats no HSA.
    const [none, now, later] = r.growth.strategy;
    expect(none!.netBenefitCents).toBe(0);
    expect(now!.netBenefitCents).toBe(35_000);
    expect(later!.netBenefitCents).toBeGreaterThan(now!.netBenefitCents);
    expect(r.growth.futureValueCents).toBeGreaterThan(r.growth.taxableValueCents);
  });

  it("finds the receipts an HSA withdrawal paid for", () => {
    const f = file([expense("x", "2026-01-01", 13_140), expense("y", "2026-02-01", 21_475), expense("z", "2026-03-01", 4_000), expense("late", "2026-09-01", 34_615)]);
    const r = buildHsaReport(input(f, [row("2026-04-01", -34_615, "Online distribution", "hsa")]));
    expect(r.withdrawals[0]!.exactMatch?.sort()).toEqual(["x", "y"]);
    expect(exactSubset([{ id: "a", amountCents: 3 }], 4)).toBeNull();
  });
});

// ---------------------------------------------------------------------------- store

describe("the HSA log file", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const fresh = () => {
    dir = mkdtempSync(path.join(tmpdir(), "hsa-"));
    return path.join(dir, "hsa-expenses.json");
  };

  it("adds, reimburses and un-reimburses, journaling every change", () => {
    const f = fresh();
    applyHsaOp({ op: "add", expenses: [{ date: "2026-02-10", amountCents: 412_500, provider: "Surgery", kind: "HOSPITAL" }] }, f);
    const [e] = readHsaFile(f).expenses;
    expect(e).toMatchObject({ provider: "Surgery", kind: "HOSPITAL", source: "MANUAL", reimbursement: null, receipt: false });
    applyHsaOp({ op: "reimburse", ids: [e!.id], date: "2026-10-01", note: "cash for car" }, f);
    expect(readHsaFile(f).expenses[0]!.reimbursement).toEqual({ date: "2026-10-01", withdrawal: null, note: "cash for car" });
    expect(applyHsaOp({ op: "unreimburse", ids: [e!.id] }, f).changed).toBe(1);
    expect(readHsaFile(f).expenses[0]!.reimbursement).toBeNull();
    const journal = readFileSync(f.replace(/\.json$/, ".journal.jsonl"), "utf8").trim().split("\n");
    expect(journal.map((l) => (JSON.parse(l) as { op: string }).op)).toEqual(["add", "reimburse", "unreimburse"]);
  });

  it("refuses bad input and never treats a damaged file as empty", () => {
    const f = fresh();
    expect(() => applyHsaOp({ op: "add", expenses: [{ date: "2026-13-01", amountCents: 100, provider: "x" }] }, f)).toThrow(/date/);
    expect(() => applyHsaOp({ op: "add", expenses: [{ date: "2026-01-01", amountCents: -5, provider: "x" }] }, f)).toThrow(/amount/);
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, "{not json");
    expect(() => readHsaFile(f)).toThrow(/damaged/);
  });

  it("remembers dismissed charges and ignored merchants once each", () => {
    const f = fresh();
    const fp = { institution: "Amex", identifiers: ["1001"], date: "2026-02-01", amountCents: -10_000, payee: "DR ONE" };
    expect(applyHsaOp({ op: "dismiss", rows: [fp, fp] }, f).changed).toBe(1);
    expect(applyHsaOp({ op: "ignoreMerchant", merchant: "CVS" }, f).changed).toBe(1);
    expect(applyHsaOp({ op: "ignoreMerchant", merchant: "CVS" }, f).changed).toBe(0);
    expect(readHsaFile(f)).toMatchObject({ dismissed: [fp], ignoredMerchants: ["CVS"] });
    applyHsaOp({ op: "undismiss", rows: [fp] }, f);
    expect(readHsaFile(f).dismissed).toEqual([]);
  });
});
