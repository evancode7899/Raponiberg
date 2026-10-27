import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkedFile, matchReceipts, receiptAmounts, receiptFacts, receiptFileDate } from "./receipts.ts";
import { receiptPath } from "./receiptScan.ts";

// A made-up insurer EOB: a summary line over the whole period, then one line per visit.
const EOB = `Explanation of Benefits
Services in this statement occurred between Feb 3, 2031 - Apr 9, 2031
Your total amount owed $65.00
OFFICE VISITS
04/09/2031
$300.00 $180.00 $0.00 $55.00 $65.00
LAB WORK 81002 on
3/20/31
48.50 12.13 36.37 36.37
Totals: 348.50 192.13 101.37 $101.37`;

describe("reading a receipt", () => {
  it("takes the date from the file name", () => {
    expect(receiptFileDate("2031.4.9.pdf")).toBe("2031-04-09");
    expect(receiptFileDate("eobs/2031-04-09 clinic.pdf")).toBe("2031-04-09");
    expect(receiptFileDate("2031.2.30.pdf")).toBeNull();
    expect(receiptFileDate("scan.pdf")).toBeNull();
  });

  it("pairs each amount with the date printed closest before it", () => {
    const a = receiptAmounts(EOB);
    // The $65 is the April visit's, not the period's first day.
    expect(a["6500"]).toEqual(["2031-04-09"]);
    expect(a["3637"]).toEqual(["2031-03-20"]);
    expect(a["10137"]).toEqual(["2031-03-20"]);
  });

  it("knows a photo or scan from a text receipt", () => {
    expect(receiptFacts("2031.4.9.jpeg", null)).toEqual({ file: "2031.4.9.jpeg", date: "2031-04-09", readable: false, amounts: {} });
    expect(receiptFacts("2031.4.9.pdf", " -- 1 of 1 -- ").readable).toBe(false);
    expect(receiptFacts("2031.4.9.pdf", EOB).readable).toBe(true);
  });
});

describe("matching receipts to expenses", () => {
  const eob = receiptFacts("2031.4.12.pdf", EOB);
  const exp = (id: string, date: string, amountCents: number, receiptRef = "") => ({ id, date, amountCents, receiptRef });

  it("proves an expense whose amount is printed beside a date that fits it", () => {
    const m = matchReceipts([exp("lab", "2031-05-02", 3637), exp("visit", "2031-04-20", 6500)], [eob]);
    expect(m.get("lab")).toEqual([{ file: "2031.4.12.pdf", how: "AMOUNT", date: "2031-03-20" }]);
    expect(m.get("visit")).toEqual([{ file: "2031.4.12.pdf", how: "AMOUNT", date: "2031-04-09" }]);
  });

  it("lets a bill be paid months later, but not a round copay", () => {
    // $36.37 paid five months on: still that bill.
    expect(matchReceipts([exp("late", "2031-08-25", 3637)], [eob]).get("late")?.[0]?.how).toBe("AMOUNT");
    // A $65.00 copay three months on is another visit's copay.
    expect(matchReceipts([exp("copay", "2031-07-15", 6500)], [eob]).has("copay")).toBe(false);
    // Nor a receipt from long after the expense.
    expect(matchReceipts([exp("early", "2031-01-02", 3637)], [eob]).has("early")).toBe(false);
  });

  it("offers a photo dated near the expense, the same-day one only to its own day", () => {
    const photo = receiptFacts("2031.6.3.png", null);
    const m = matchReceipts([exp("day", "2031-06-03", 1299), exp("next", "2031-06-04", 4000), exp("far", "2031-06-20", 1299)], [photo]);
    expect(m.get("day")).toEqual([{ file: "2031.6.3.png", how: "DATE", date: "2031-06-03" }]);
    expect(m.has("next")).toBe(false);
    expect(m.has("far")).toBe(false);
    // With no expense on its own day, a neighbour within three days gets it.
    expect(matchReceipts([exp("next", "2031-06-04", 4000)], [photo]).get("next")?.[0]?.how).toBe("DATE");
  });

  it("puts the owner's tie first, by path or bare name", () => {
    const photo = receiptFacts("pharmacy/2031.6.3.png", null);
    expect(linkedFile("2031.6.3.png", [photo])).toBe(photo);
    expect(linkedFile("C:\\Receipts\\pharmacy\\2031.6.3.png", [photo])).toBe(photo);
    expect(linkedFile("in the drawer", [photo])).toBeUndefined();
    const m = matchReceipts([exp("lab", "2031-05-02", 3637, "pharmacy/2031.6.3.png")], [eob, photo]);
    expect(m.get("lab")!.map((x) => x.how)).toEqual(["LINKED", "AMOUNT"]);
  });
});

describe("opening a receipt", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("serves only receipt files inside the folder", () => {
    dir = mkdtempSync(path.join(tmpdir(), "hsa-receipts-"));
    writeFileSync(path.join(dir, "2031.4.9.pdf"), "x");
    writeFileSync(path.join(dir, "notes.txt"), "x");
    expect(receiptPath("2031.4.9.pdf", dir)).toBe(path.join(dir, "2031.4.9.pdf"));
    expect(receiptPath("notes.txt", dir)).toBeNull();
    expect(receiptPath("../2031.4.9.pdf", dir)).toBeNull();
    expect(receiptPath("missing.pdf", dir)).toBeNull();
    expect(receiptPath("2031.4.9.pdf", null)).toBeNull();
  });
});
