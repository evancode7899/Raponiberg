import { describe, expect, it } from "vitest";
import { guessProduct, productById } from "./catalog";
import { buildCardPerks, periodKey, periodsOf, type CardAccount, type PerkRow } from "./report";
import { normalizeCardPerks, setupFromProduct, usageKey, pointsKey, type CardPerksSettings } from "./settings";

const gold: CardAccount = { id: "gold", name: "AMERICAN EXPRESS GOLD CARD", institution: "American Express", from: "2025-01-01", through: "2025-09-30" };

let n = 0;
const row = (date: string, payee: string, dollars: number, extra: Partial<PerkRow> = {}): PerkRow => ({
  id: `r${++n}`,
  date,
  amountCents: Math.round(dollars * 100),
  lane: "EXPENSE",
  accountId: "gold",
  payee,
  category: "Shopping & gifts",
  classifiedBy: dollars > 0 ? "card-perk-credit" : "merchant",
  ...extra,
});

const settings = (x: Partial<CardPerksSettings> = {}): CardPerksSettings => ({ ...normalizeCardPerks(null), ...x });
const score = (rows: PerkRow[], s = settings(), today = "2025-10-15", account = gold) => buildCardPerks({ settings: s, accounts: [account], rows, today, year: 2025 }).cards[0]!;

describe("periods", () => {
  it("splits a year by cadence and finds a date's period", () => {
    expect(periodsOf("MONTHLY", 2025)).toHaveLength(12);
    expect(periodsOf("QUARTERLY", 2024)[0]).toEqual({ key: "2024-Q1", label: "Q1", start: "2024-01-01", end: "2024-03-31" });
    expect(periodsOf("SEMIANNUAL", 2025)[1]).toMatchObject({ key: "2025-H2", start: "2025-07-01", end: "2025-12-31" });
    expect(periodsOf("MONTHLY", 2024)[1]!.end).toBe("2024-02-29");
    expect(periodKey("QUARTERLY", "2025-05-31")).toBe("2025-Q2");
    expect(periodKey("SEMIANNUAL", "2025-07-01")).toBe("2025-H2");
    expect(periodKey("ANNUAL", "2025-07-01")).toBe("2025");
  });
});

describe("catalog", () => {
  it("suggests a product from the account name, and only for the right issuer", () => {
    expect(guessProduct(gold)?.id).toBe("amex-gold");
    expect(guessProduct({ name: "SAPPHIRE RESERVE", institution: "Chase" })?.id).toBe("chase-sapphire-reserve");
    expect(guessProduct({ name: "Example Bank Platinum Rewards", institution: "Example Bank" })).toBeNull();
  });
});

describe("card perks scorecard", () => {
  it("matches statement credits to perks by period and counts what was missed", () => {
    const c = score([row("2025-01-09", "GRUBHUB CREDIT", 10), row("2025-02-11", "AMEX DINING CREDIT", 10), row("2025-03-15", "RESY CREDIT", 50), row("2025-04-02", "AMEX DUNKIN CREDIT", 7)]);
    const dining = c.perks.find((p) => p.id === "dining")!;
    expect(dining.periods.slice(0, 4).map((p) => p.status)).toEqual(["USED", "USED", "MISSED", "MISSED"]);
    // Through September is in: Jan–Sep minus two used = 7 missed; October is open; Nov and Dec are ahead.
    expect(dining.used).toBe(2_000);
    expect(dining.missed).toBe(7_000);
    expect(dining.remaining).toBe(3_000);
    expect(dining.periods[9]!.status).toBe("OPEN");
    expect(dining.periods[11]!.status).toBe("FUTURE");
    const resy = c.perks.find((p) => p.id === "resy")!;
    expect(resy.periods.map((p) => p.status)).toEqual(["USED", "OPEN"]);
    expect(c.perksValueCents).toBe(2_000 + 5_000 + 700);
    // Credits aren't spending.
    expect(c.spend.chargesCents).toBe(0);
  });

  it("fills a perk's period before spilling into the next matching perk", () => {
    const s = settings({
      cards: {
        gold: { ...setupFromProduct(null), perks: [
          { id: "monthly", name: "Ride credit", cadence: "MONTHLY", unit: "USD", amount: 1_500, pattern: "RIDE CREDIT", note: "" },
          { id: "december", name: "Ride credit (December)", cadence: "ANNUAL", unit: "USD", amount: 2_000, pattern: "RIDE CREDIT", note: "" },
        ] },
      },
    });
    const c = score([row("2025-03-03", "RIDE CREDIT", 15), row("2025-03-04", "RIDE CREDIT", 20)], s);
    expect(c.perks[0]!.periods[2]).toMatchObject({ used: 1_500, status: "USED" });
    expect(c.perks[1]!.used).toBe(2_000);
  });

  it("a use marked by hand replaces the statements, and an in-app perk counts only when marked", () => {
    const s = settings({ usage: { [usageKey("gold", "uber", "2025-02")]: 1_000, [usageKey("gold", "dining", "2025-01")]: 0 } });
    const c = score([row("2025-01-09", "GRUBHUB CREDIT", 10)], s);
    const uber = c.perks.find((p) => p.id === "uber")!;
    expect(uber.periods[1]).toMatchObject({ used: 1_000, source: "MANUAL", status: "USED" });
    expect(uber.periods[0]!.status).toBe("MISSED");
    const dining = c.perks.find((p) => p.id === "dining")!;
    expect(dining.periods[0]).toMatchObject({ used: 0, detected: 1_000, source: "MANUAL", status: "MISSED" });
  });

  it("waits on a statement before calling a period missed, and skips months before the card", () => {
    const c = score([], settings(), "2025-10-15", { ...gold, from: "2025-03-05", through: "2025-07-31" });
    const dunkin = c.perks.find((p) => p.id === "dunkin")!;
    expect(dunkin.periods.map((p) => p.status).slice(0, 10)).toEqual(["NOT_HELD", "NOT_HELD", "MISSED", "MISSED", "MISSED", "MISSED", "MISSED", "AWAITING", "AWAITING", "OPEN"]);
    expect(dunkin.allowance).toBe(700 * 10);
  });

  it("estimates points by category and description, valued at the cents per point", () => {
    const rows = [
      row("2025-02-01", "TST* CORNER TRATTORIA", -100, { category: "Dining" }),
      row("2025-02-02", "SPRINGFIELD MARKET", -50, { category: "Groceries" }),
      row("2025-02-03", "EXAMPLE AIR LINES", -200, { category: "Travel & entertainment" }),
      row("2025-02-04", "HARDWARE STORE", -80),
      row("2025-02-05", "HARDWARE STORE", 30, { classifiedBy: "merchant" }),
    ];
    const c = score(rows, settings({ centsPerPoint: 1.5 }));
    expect(c.spend).toEqual({ chargesCents: 43_000, refundsCents: 3_000, netCents: 40_000 });
    // 400 dining + 200 groceries + 600 flights + 80 − 30 everything else.
    expect(c.points.estimated).toBe(1_250);
    expect(c.points.valueCents).toBe(1_875);
    expect(c.earn.find((l) => l.label === "Everything else")).toMatchObject({ rate: 1, spendCents: 5_000, points: 50 });

    const entered = score(rows, settings({ pointsEarned: { [pointsKey("gold", 2025)]: 2_000 } }));
    expect(entered.points).toMatchObject({ estimated: 1_250, entered: 2_000, earned: 2_000, valueCents: 2_000 });
  });

  it("takes the fee from the statements, net of a reversal, else from the card's terms", () => {
    const fee = row("2025-03-01", "ANNUAL MEMBERSHIP FEE", -325, { section: "Fees", category: "Taxes & fees", classifiedBy: "card-fee-interest" });
    const back = row("2025-03-20", "ANNUAL MEMBERSHIP FEE CREDIT", 100, { category: "Taxes & fees" });
    const c = score([fee, back, row("2025-03-02", "LATE FEE", -40, { section: "Fees" })]);
    expect(c.fee).toMatchObject({ chargedCents: 22_500, cents: 22_500, source: "STATEMENTS" });
    expect(c.credits).toHaveLength(0);
    expect(c.spend.chargesCents).toBe(0);

    const terms = score([]);
    expect(terms.fee).toMatchObject({ cents: 32_500, source: "TERMS" });
    expect(terms.netCents).toBe(-32_500);
  });

  it("counts issuer offers as value but never points cashed in, and a merchant refund saying CREDIT as a refund", () => {
    const c = score([
      row("2025-05-01", "AMEX OFFER CREDIT EXAMPLE SHOP", 25),
      row("2025-05-02", "POINTS FOR CREDIT", 100),
      row("2025-05-03", "HARDWARE STORE CREDIT", 12, { classifiedBy: "merchant" }),
    ]);
    expect(c.credits.map((x) => x.kind)).toEqual(["OTHER", "REDEMPTION"]);
    expect(c.otherCreditsCents).toBe(2_500);
    expect(c.spend.refundsCents).toBe(1_200);
  });

  it("adds up the year and leaves hidden cards out", () => {
    const other: CardAccount = { id: "other", name: "Example Card", institution: "Example Bank", from: "2025-01-01", through: "2025-09-30" };
    const s = settings({ cards: { other: { ...setupFromProduct(null), hidden: true } } });
    const r = buildCardPerks({ settings: s, accounts: [gold, other], rows: [row("2025-01-09", "GRUBHUB CREDIT", 10)], today: "2025-10-15", year: 2025 });
    expect(r.cards.map((c) => c.accountId)).toEqual(["gold"]);
    expect(r.hidden).toEqual([{ accountId: "other", accountName: "Example Card" }]);
    expect(r.totals.netCents).toBe(1_000 - 32_500);
    expect(r.totals).toMatchObject({ creditsCents: 1_000, cardsWithFee: 1 });
    // Gold's four perks each have a period under way in October.
    expect(r.totals.openPerks).toBe(4);
    expect(r.cards[0]).toMatchObject({ creditsCents: 1_000, returnedCents: 1_000 });
    expect(r.years).toEqual([2025]);
  });

  it("flags a pattern that isn't a valid regular expression instead of failing", () => {
    const s = settings({ cards: { gold: { ...setupFromProduct(productById("amex-gold")), perks: [{ id: "x", name: "Broken", cadence: "ANNUAL", unit: "USD", amount: 100, pattern: "(", note: "" }] } } });
    expect(score([row("2025-01-09", "ANY CREDIT", 1)], s).perks[0]).toMatchObject({ patternError: true, used: 0 });
  });
});

describe("settings", () => {
  it("normalizes damaged input to something usable", () => {
    const s = normalizeCardPerks({
      centsPerPoint: -1,
      cards: { a: { productId: "amex-gold", perks: [{ name: "", cadence: "MONTHLY", amount: 1 }, { id: "p", name: "Ok", cadence: "WEEKLY", amount: 1 }, { name: "Kept", cadence: "ANNUAL", amount: 500 }, { id: "perk-3", name: "Twin", cadence: "ANNUAL", amount: 1 }] } },
      usage: { "a|p|2025-13": 5, "a|p|2025-Q2": 5, "a|p|2025-H1": -1 },
      pointsEarned: { "a|2025": 10, bad: 1 },
    });
    expect(s.centsPerPoint).toBe(1);
    expect(s.cards.a!.name).toBe("American Express Gold Card");
    expect(s.cards.a!.perks.map((p) => [p.id, p.name])).toEqual([["perk-1", "Kept"], ["perk-3", "Twin"]]);
    expect(s.usage).toEqual({ "a|p|2025-Q2": 5 });
    expect(s.pointsEarned).toEqual({ "a|2025": 10 });
  });

  it("a card set up from the catalog keeps its own copy", () => {
    const setup = setupFromProduct(productById("amex-gold"));
    setup.perks[0]!.amount = 1;
    expect(productById("amex-gold")!.perks[0]!.amount).toBe(1_000);
  });
});
