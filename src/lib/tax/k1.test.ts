import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { K1Form } from "../taxdocs/types";
import { annualizedK1, completeK1, expectedK1, k1Gaps, k1Items, k1Passive, k1Rows } from "./k1";
import { k1DetailFor, readK1Details, type K1Detail, type K1DetailLine } from "./k1DetailStore";

// Every name and figure here is made up.
const $ = (d: number) => Math.round(d * 100);
const EIN = "00-1234567";

const form = (over: Partial<K1Form> = {}): K1Form => ({ ...expectedK1(null, "EXAMPLE FUND LP", EIN, {}), partner: "PAT EXAMPLE", ...over });
const line = (box: string, code: string, cents: number, treatment: K1DetailLine["treatment"], state?: string): K1DetailLine => ({ box, code, label: `Example ${box}${code}`, cents, treatment, ...(state ? { state } : {}) });
const detail = (lines: K1DetailLine[], over: Partial<K1Detail> = {}): K1Detail => ({ ein: EIN, year: 2025, lines, ...over });

describe("a K-1 sorted into the return's places", () => {
  it("passes the face's portfolio boxes through and nets boxes 1–3 as one activity", () => {
    const k = k1Items(form({ ordinaryBusiness: -$(700), rentalRealEstate: -$(1_900), interest: $(2_100), ordinaryDividends: $(3_600), qualifiedDividends: $(3_000), longTermGain: $(5_000), foreignTax: $(40) }), null);
    expect(k).toMatchObject({ interest: $(2_100), ordinaryDividends: $(3_600), qualifiedDividends: $(3_000), longTermGain: $(5_000), activity: -$(2_600), passive: true, foreignTax: $(40) });
  });

  it("splits section 1256 gain 60% long and 40% short", () => {
    const k = k1Items(form({ longTermGain: $(1_000) }), detail([line("11", "C", $(10_000), "SECTION_1256")]));
    expect(k.longTermGain).toBe($(7_000));
    expect(k.shortTermGain).toBe($(4_000));
  });

  it("moves a carried interest's three-year amount from long-term to short-term", () => {
    const k = k1Items(form({ longTermGain: $(50_000) }), detail([line("20", "AH", $(12_000), "SECTION_1061_RECHARACTERIZED")]));
    expect(k).toMatchObject({ longTermGain: $(38_000), shortTermGain: $(12_000) });
  });

  it("takes a net section 1231 gain as long-term and a net loss as ordinary", () => {
    expect(k1Items(form({ section1231: $(4_000) }), null)).toMatchObject({ longTermGain: $(4_000), activity: 0 });
    expect(k1Items(form({ section1231: -$(4_000) }), null)).toMatchObject({ longTermGain: 0, activity: -$(4_000) });
  });

  it("reads deductions as positive however the statement signs them", () => {
    const k = k1Items(form(), detail([line("13", "H", -$(380), "INVESTMENT_INTEREST_EXPENSE"), line("20", "B", $(120), "INVESTMENT_EXPENSE_NII_ONLY"), line("13", "L", -$(900), "PORTFOLIO_DEDUCTION_NOT_DEDUCTIBLE")]));
    expect(k).toMatchObject({ investmentInterestExpense: $(380), investmentExpensesNiiOnly: $(120), activity: 0, otherPortfolioIncome: 0 });
  });

  it("keeps each state's items apart", () => {
    const k = k1Items(form(), detail([line("STATE", "", $(900), "PTE_TAX_CREDIT", "CT"), line("STATE", "", $(2_000), "STATE_SOURCE_INCOME", "NY"), line("STATE", "", $(150), "STATE_TAX_WITHHELD", "NY")]));
    expect(k.states).toEqual({ CT: { addition: 0, subtraction: 0, sourceIncome: 0, pteCredit: $(900), withheld: 0 }, NY: { addition: 0, subtraction: 0, sourceIncome: $(2_000), pteCredit: 0, withheld: $(150) } });
  });

  it("gathers the business income deduction's inputs", () => {
    const k = k1Items(form(), detail([line("20", "Z", $(30_000), "QBI_INCOME"), line("20", "Z", $(8_000), "QBI_W2_WAGES"), line("20", "Z", $(100_000), "QBI_UBIA"), line("20", "Z", 1, "QBI_SSTB")]));
    expect(k.qbi).toEqual({ income: $(30_000), w2Wages: $(8_000), ubia: $(100_000), sstb: true, reitDividends: 0 });
  });
});

describe("whether boxes 1–3 are passive", () => {
  it("is passive for a limited partner, never for a trader fund, and as the details file says", () => {
    expect(k1Passive({ limitedPartner: true }, null)).toBe(true);
    expect(k1Passive({ limitedPartner: false }, null)).toBe(false);
    expect(k1Passive({ limitedPartner: true }, detail([], { activity: "TRADER_FUND" }))).toBe(false);
    expect(k1Passive({ limitedPartner: false }, detail([], { activity: "RENTAL" }))).toBe(true);
    expect(k1Passive({ limitedPartner: true }, detail([], { passive: false }))).toBe(false);
  });
});

describe("what of a K-1 is still unread", () => {
  const face = form({
    coded: [
      { box: "11", code: "A", cents: null, statement: true },
      { box: "11", code: "", cents: null, statement: true },
      { box: "13", code: "H", cents: $(38), statement: true },
      { box: "20", code: "A", cents: $(61), statement: false },
    ],
  });

  it("lists every lettered entry with no line in the details file, a bare 'see statement' aside", () => {
    expect(k1Gaps(face, null).map((g) => `${g.box}${g.code}`)).toEqual(["11A", "13H", "20A"]);
  });

  it("is settled once each entry has its lines, adding up to the face", () => {
    const d = detail([line("11", "A", $(900), "ORDINARY_PORTFOLIO"), line("13", "H", -$(38), "INVESTMENT_INTEREST_EXPENSE"), line("20", "A", $(61), "INFORMATION_ONLY")]);
    expect(k1Gaps(face, d)).toEqual([]);
  });

  it("says when the lines don't add up to the amount the face prints", () => {
    const d = detail([line("11", "A", $(900), "ORDINARY_PORTFOLIO"), line("13", "H", $(30), "INVESTMENT_INTEREST_EXPENSE"), line("20", "A", $(61), "INFORMATION_ONLY")]);
    expect(k1Gaps(face, d)).toEqual([expect.objectContaining({ box: "13", code: "H", why: expect.stringMatching(/\$38.*\$30/) })]);
  });
});

describe("a K-1 for a year still in progress", () => {
  it("scales a part-year K-1 to twelve months", () => {
    const a = annualizedK1(form({ periodStart: "2025-07-02", periodEnd: "2025-12-31", interest: $(1_830), longTermGain: -$(183) }))!;
    expect(a.days).toBe(183);
    expect(a.form).toMatchObject({ interest: $(3_650), longTermGain: -$(365) });
  });

  it("leaves a full-year K-1, or one with no period, alone", () => {
    expect(annualizedK1(form({ periodStart: "2025-01-01", periodEnd: "2025-12-31" }))).toBeNull();
    expect(annualizedK1(form())).toBeNull();
  });

  it("puts the partnership's expected figures over last year's K-1", () => {
    const k = expectedK1(form({ limitedPartner: false, generalPartner: true, interest: $(5) }), "EXAMPLE FUND LP", EIN, { interest: $(9_000), longTermGain: $(40_000) });
    expect(k).toMatchObject({ limitedPartner: false, generalPartner: true, interest: $(9_000), longTermGain: $(40_000), ordinaryDividends: 0, coded: [] });
  });
});

describe("a K-1 scanned before the reader kept every box", () => {
  it("reads the boxes it lacks as empty", () => {
    const old = { partnership: "EXAMPLE FUND LP", ein: EIN, interest: $(10) } as K1Form;
    expect(completeK1(old)).toMatchObject({ interest: $(10), collectibles28: 0, coded: [], amended: false, capital: { ending: null } });
  });
});

describe("the K-1's rows on the Income tab", () => {
  it("shows each box with an amount, each unread lettered amount, and each statement line", () => {
    const f = form({ interest: $(100), coded: [{ box: "20", code: "A", cents: $(61), statement: false }, { box: "13", code: "H", cents: $(38), statement: true }] });
    const rows = k1Rows(f, detail([line("13", "H", -$(38), "INVESTMENT_INTEREST_EXPENSE")]));
    expect(rows.map((r) => [r.id, r.cents, r.where])).toEqual([
      ["face:interest", $(100), "Interest"],
      ["coded:0", $(61), "Not read yet"],
      ["line:0", -$(38), "Investment interest (itemized)"],
    ]);
  });
});

describe("the K-1 details file", () => {
  const write = (body: unknown) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "k1-")), "k1-details.json");
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };

  it("reads as none when missing, and finds an entry by EIN and year", () => {
    expect(readK1Details(path.join(tmpdir(), "no-such-k1-details.json"))).toEqual({ version: 1, k1s: [] });
    const f = readK1Details(write({ version: 1, k1s: [detail([line("11", "A", $(1), "ORDINARY_PORTFOLIO")])] }));
    expect(k1DetailFor(f, EIN, 2025)!.lines).toHaveLength(1);
    expect(k1DetailFor(f, EIN, 2024)).toBeNull();
    expect(k1DetailFor({ error: "damaged" }, EIN, 2025)).toBeNull();
  });

  it("is an error, never none, when damaged or malformed", () => {
    expect(() => readK1Details(write("{"))).toThrow(/damaged/);
    expect(() => readK1Details(write({ version: 1, k1s: [{ ein: "bad", year: 2025, lines: [] }] }))).toThrow(/EIN/);
    expect(() => readK1Details(write({ version: 1, k1s: [detail([]), detail([])] }))).toThrow(/two entries/);
    expect(() => readK1Details(write({ version: 1, k1s: [detail([{ ...line("11", "A", 1, "ORDINARY_PORTFOLIO"), treatment: "GUESS" as never }])] }))).toThrow(/known treatment/);
    expect(() => readK1Details(write({ version: 1, k1s: [detail([line("STATE", "", 1, "PTE_TAX_CREDIT")])] }))).toThrow(/two-letter state/);
    expect(() => readK1Details(write({ version: 2, k1s: [] }))).toThrow(/newer version/);
  });
});
