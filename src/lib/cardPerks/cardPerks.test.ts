import { describe, expect, it } from "vitest";
import { guessProduct, productById, PROGRAMS } from "./catalog";
import { periodKey, periodsOf } from "./periods";
import { buildCardPerks, type CardPerksInput } from "./report";
import { buildPools, estimateEarn } from "./rewards";
import { readRewards } from "./rewardsText";
import { defaultCardPerks, normalizeCardPerks } from "./settings";
import type { CardAccount, PerkRow, StatementRewards } from "./types";

// ---- Made-up fixtures: Pat Example's cards, ••1234 and friends ----

/** Monthly statements closing on the 20th, from `from` through `to` (YYYY-MM). */
function statements(id: string, from: string, to: string): CardAccount["statements"] {
  const out = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    const pm = m === 1 ? 12 : m - 1;
    const py = m === 1 ? y - 1 : y;
    out.push({ id: `${id}-${y}-${String(m).padStart(2, "0")}`, start: `${py}-${String(pm).padStart(2, "0")}-21`, end: `${y}-${String(m).padStart(2, "0")}-20` });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

const gold: CardAccount = { id: "gold", name: "Amex Gold Card ••1234", institution: "American Express", statements: statements("gold", "2024-01", "2025-11") };
const plat: CardAccount = { id: "plat", name: "The Platinum Card ••5678", institution: "American Express", statements: statements("plat", "2024-01", "2025-11") };
const cash: CardAccount = { id: "cash", name: "Blue Cash Everyday® ••4321", institution: "American Express", statements: statements("cash", "2024-01", "2025-11") };
const bilt: CardAccount = { id: "bilt", name: "Bilt Blue Card ••1111", institution: "Bilt", statements: statements("bilt", "2025-01", "2025-11") };

let n = 0;
/** A row on a card: negative dollars are charges, positive are credits. Its statement is the cycle it falls in. */
function row(account: CardAccount, date: string, payee: string, dollars: number, extra: Partial<PerkRow> = {}): PerkRow {
  const st = account.statements.find((s) => s.start <= date && s.end >= date) ?? account.statements.at(-1)!;
  return {
    id: `r${++n}`,
    date,
    amountCents: Math.round(dollars * 100),
    lane: "EXPENSE",
    accountId: account.id,
    payee,
    detail: null,
    section: dollars > 0 ? "Credits" : null,
    category: "Shopping & gifts",
    classifiedBy: dollars > 0 && /CREDIT|BONUS/.test(payee) ? "card-perk-credit" : "merchant",
    statementId: st.id,
    ...extra,
  };
}

const build = (x: Partial<CardPerksInput> & { accounts: CardAccount[]; rows: PerkRow[] }) =>
  buildCardPerks({ settings: defaultCardPerks(), householdRows: [], snapshots: [], today: "2025-12-05", year: 2025, ...x });
const cardOf = (r: ReturnType<typeof build>, id: string) => r.cards.find((c) => c.accountId === id)!;
const perkOf = (r: ReturnType<typeof build>, id: string, perk: string) => cardOf(r, id).perks.find((p) => p.id === perk)!;
const period = (r: ReturnType<typeof build>, id: string, perk: string, key: string) => perkOf(r, id, perk).periods.find((p) => p.key === key)!;

describe("periods", () => {
  it("splits a year by cadence and finds a date's period", () => {
    expect(periodsOf("MONTHLY", 2025)).toHaveLength(12);
    expect(periodsOf("QUARTERLY", 2024)[0]).toEqual({ key: "2024-Q1", label: "Q1", start: "2024-01-01", end: "2024-03-31" });
    expect(periodsOf("MONTHLY", 2024)[1]!.end).toBe("2024-02-29");
    expect(periodKey("SEMIANNUAL", "2025-07-01")).toBe("2025-H2");
  });
});

describe("catalog", () => {
  it("knows each card from its account name, and only for the right issuer", () => {
    expect(guessProduct(gold)?.id).toBe("amex-gold");
    expect(guessProduct(plat)?.id).toBe("amex-platinum");
    expect(guessProduct(cash)?.id).toBe("amex-blue-cash-everyday");
    expect(guessProduct(bilt)?.id).toBe("bilt-blue");
    expect(guessProduct({ name: "Capital One Quicksilver ••2222", institution: "Capital One" })?.id).toBe("capital-one-quicksilver");
    expect(guessProduct({ name: "Capital One Platinum ••3333", institution: "Capital One" })?.id).toBe("capital-one-platinum");
    expect(guessProduct({ name: "Chase Freedom Unlimited ••4444", institution: "Chase" })?.id).toBe("chase-freedom-unlimited");
    expect(guessProduct({ name: "Example Bank Rewards", institution: "Example Bank" })).toBeNull();
  });

  it("files cash back cards as cash, not points", () => {
    for (const id of ["amex-blue-cash-everyday", "capital-one-quicksilver"]) expect(PROGRAMS[productById(id)!.program].kind).toBe("CASH");
    expect(PROGRAMS[productById("capital-one-platinum")!.program].kind).toBe("NONE");
    expect(PROGRAMS[productById("amex-gold")!.program].kind).toBe("POINTS");
  });
});

describe("statement rewards summaries", () => {
  it("reads a Membership Rewards balance as of the month end, and the older undated one", () => {
    const now = "americanexpress.com\nMembership Rewards® Points\nAvailable and Pending as of 03/31/25\n12,345\nFor more details";
    expect(readRewards(now)).toEqual({ program: "amex-mr", unit: "POINTS", balance: 12345, asOf: "2025-03-31" });
    expect(readRewards("American Express\nMembership Rewards® Points\n9,876\nGold Card")).toMatchObject({ balance: 9876, asOf: null });
  });

  it("reads Reward Dollars as cents of cash back", () => {
    expect(readRewards("americanexpress.com\nReward Dollars\nas of 02/10/2025\n123.45\nFor more")).toEqual({ program: "amex-cash", unit: "CASH", balance: 12345, asOf: "2025-02-10" });
  });

  it("reads Chase's points line by line, even when the total runs into a date", () => {
    const text = [
      "chase.com/cardhelp",
      "Previous points balance 1,000",
      "+ 1.5% (1.5 Pts)/$1 earned on all purchases 150",
      "+ 1.5%(1.5 Pts)/$1 addl on Dining purchases 40",
      "3.5%(3.5 Pts)/$1 addl on Chase Travel 0",
      "Total points available for",
      "redemption 1,19004/07/25",
    ].join("\n");
    expect(readRewards(text)).toMatchObject({ program: "chase-ur", balance: 1190, previous: 1000, earned: 190, redeemed: 0 });
  });

  it("reads Capital One's cash back with what was earned and redeemed", () => {
    const text = "capitalone.com\nRewards Summary \tRewards as of: 04/18/2025\nRewards Balance\n$12.50 Track and redeem\nPrevious Balance \tEarned This Period \tRedeemed this period\n$10.00 \t$2.50 \t$0.00";
    expect(readRewards(text)).toEqual({ program: "capital-one-cash", unit: "CASH", balance: 1250, asOf: "2025-04-18", previous: 1000, earned: 250, redeemed: 0 });
  });

  it("returns null for a statement without one", () => {
    expect(readRewards("Some other card statement\nNew Balance $12.00")).toBeNull();
  });
});

describe("perks, with no marking by hand", () => {
  it("counts a statement credit in the month of the charge it pays back", () => {
    const rows = [row(gold, "2025-03-30", "GRUBHUB ORDER", -25), row(gold, "2025-04-02", "AMEX DINING CREDIT", 10)];
    const r = build({ accounts: [gold], rows });
    expect(period(r, "gold", "dining", "2025-03")).toMatchObject({ status: "USED", usedCents: 1_000 });
    expect(period(r, "gold", "dining", "2025-04").status).toBe("MISSED");
  });

  it("counts a credit named after an eligible merchant, and never more than the allowance", () => {
    const rows = [row(plat, "2025-02-03", "HULU", -30), row(plat, "2025-02-05", "HULU", 20), row(plat, "2025-02-06", "HULU", 20)];
    const r = build({ accounts: [plat], rows });
    expect(period(r, "plat", "entertainment", "2025-02")).toMatchObject({ status: "USED", usedCents: 2_000 });
  });

  it("infers Uber Cash from household Uber charges: one charge covers one card, two cover two", () => {
    const rows = [row(gold, "2025-05-10", "UBER TRIP HELP.UBER.COM", -18), row(gold, "2025-06-03", "UBER EATS", -22)];
    const debit = { ...row(gold, "2025-06-15", "UBER TRIP", -9), accountId: "checking" };
    const r = build({ accounts: [gold, plat], rows, householdRows: [debit] });
    // May: one charge, so the larger credit (Platinum's) is the one used.
    expect(period(r, "plat", "uber", "2025-05").status).toBe("USED");
    expect(period(r, "gold", "uber", "2025-05").status).toBe("MISSED");
    // June: a card charge and a debit card charge: both cards' credits.
    expect(period(r, "gold", "uber", "2025-06").status).toBe("USED");
    expect(period(r, "plat", "uber", "2025-06").status).toBe("USED");
    expect(period(r, "gold", "uber", "2025-06").evidence[0]!.kind).toBe("SPEND");
  });

  it("waits for the statement before calling a period missed, and doesn't count credits added after a card closed", () => {
    const closed: CardAccount = { ...plat, closed: true, statements: statements("plat", "2025-01", "2025-07") };
    const r = build({ accounts: [closed, gold], rows: [] });
    // Refreshed credits started after the card closed: never offered to it.
    expect(cardOf(r, "plat").perks.find((p) => p.id === "oura")).toBeUndefined();
    expect(period(r, "plat", "uber", "2025-09").status).toBe("NOT_HELD");
    // Gold's statements run to Nov 20: November's dining credit could still post.
    expect(period(r, "gold", "dining", "2025-11").status).toBe("AWAITING");
    expect(period(r, "gold", "dining", "2025-12").status).toBe("OPEN");
    expect(perkOf(r, "gold", "dunkin").neverUsed).toBe(true);
    expect(r.act.map((a) => a.perkId)).toContain("dining");
  });
});

describe("rewards", () => {
  it("earns each purchase at its rule up to the yearly cap, then the base rate", () => {
    const product = productById("amex-blue-cash-everyday")!;
    const rows = [row(cash, "2025-02-01", "SUPERMARKET", -5_000, { category: "Groceries" }), row(cash, "2025-03-01", "SUPERMARKET", -2_000, { category: "Groceries" })];
    const earned = estimateEarn(product, PROGRAMS["amex-cash"], rows);
    // 3% on the first $6,000, 1% on the $1,000 past it: cents of cash back.
    expect(earned.reduce((t, e) => t + e.units, 0)).toBeCloseTo(6_000 * 3 + 1_000 * 1);
  });

  it("reconciles printed balances: a rise is what posted, a fall leaves the estimate and infers the redemption", () => {
    const expected = new Map([
      ["gold-2025-02", 1_000],
      ["gold-2025-03", 1_000],
    ]);
    const snap = (statementId: string, asOf: string, balance: number): StatementRewards => ({ program: "amex-mr", unit: "POINTS", balance, asOf, accountId: "gold", statementId, statementEnd: asOf });
    const pools = buildPools({
      cards: [{ accountId: "gold", program: PROGRAMS["amex-mr"], centsPerPoint: 1, statements: gold.statements }],
      snapshots: [snap("gold-2025-02", "2025-01-31", 5_000), snap("gold-2025-03", "2025-02-28", 7_500), snap("gold-2025-04", "2025-03-31", 500)],
      expected,
      redemptions: [],
    });
    const [rise, fall] = pools[0]!.stretches;
    expect(rise).toMatchObject({ posted: 2_500, expected: 1_000, difference: 1_500, basis: "BALANCES" });
    expect(fall).toMatchObject({ posted: 1_000, redeemed: 8_000, basis: "INFERRED" });
  });

  it("pools a shared Membership Rewards balance across both cards", () => {
    const snaps: StatementRewards[] = [
      { program: "amex-mr", unit: "POINTS", balance: 100, asOf: "2025-01-31", accountId: "gold", statementId: "gold-2025-02", statementEnd: "2025-02-20" },
      { program: "amex-mr", unit: "POINTS", balance: 100, asOf: "2025-01-31", accountId: "plat", statementId: "plat-2025-02", statementEnd: "2025-02-20" },
    ];
    const pools = buildPools({
      cards: [gold, plat].map((a) => ({ accountId: a.id, program: PROGRAMS["amex-mr"], centsPerPoint: 1, statements: a.statements })),
      snapshots: snaps,
      expected: new Map(),
      redemptions: [],
    });
    expect(pools).toHaveLength(1);
    expect(pools[0]!.accountIds).toEqual(["gold", "plat"]);
  });

  it("values cash back at face and points at the program's value, and counts cash cashed in exactly", () => {
    const rows = [row(cash, "2025-03-25", "SUPERMARKET", -100, { category: "Groceries" }), row(cash, "2025-04-15", "YOUR CASH REWARD/REFUND IS", 50)];
    const snaps: StatementRewards[] = [
      { program: "amex-cash", unit: "CASH", balance: 5_000, asOf: "2025-03-20", accountId: "cash", statementId: "cash-2025-03", statementEnd: "2025-03-20" },
      { program: "amex-cash", unit: "CASH", balance: 300, asOf: "2025-04-20", accountId: "cash", statementId: "cash-2025-04", statementEnd: "2025-04-20" },
      { program: "amex-cash", unit: "CASH", balance: 400, asOf: "2025-05-20", accountId: "cash", statementId: "cash-2025-05", statementEnd: "2025-05-20" },
    ];
    const settings = normalizeCardPerks({ pointValues: { "amex-mr": 2 } });
    const r = build({ accounts: [cash], rows, snapshots: snaps, settings });
    const c = cardOf(r, "cash");
    expect(c.program.kind).toBe("CASH");
    expect(c.credits.find((x) => x.kind === "REDEMPTION")?.amountCents).toBe(5_000);
    const may = r.pools[0]!.stretches.at(-1)!;
    expect(may).toMatchObject({ posted: 100, basis: "BALANCES" });
    // $100 of groceries at 3% = $3.00, posted in the April stretch (balance 300 + 5,000 cashed out − 5,000 opening).
    expect(r.pools[0]!.stretches[0]).toMatchObject({ expected: 300, posted: 300, redeemed: 5_000 });
    expect(c.rewards.valueCents).toBe(c.rewards.earned);
  });

  it("earns Bilt rent points while ignoring the rent charge's reversal", () => {
    const rows = [row(bilt, "2025-03-01", "BPS*BILT HOUSING 123 MAIN", -2_000, { category: "Housing & utilities" }), row(bilt, "2025-03-01", "BILT RENT CHARGE ADJUSTMENT", 2_000, { classifiedBy: "merchant" })];
    const c = cardOf(build({ accounts: [bilt], rows }), "bilt");
    expect(c.earn.find((l) => l.id === "rent")).toMatchObject({ spendCents: 200_000, units: 2_000 });
    expect(c.credits).toEqual([]);
    expect(c.rewards.source).toBe("ESTIMATE");
  });
});

describe("the year's score", () => {
  it("takes the fee from the statements and counts offers, never redemptions, as value", () => {
    const rows = [
      row(gold, "2025-08-20", "ANNUAL MEMBERSHIP FEE", -325, { section: "Fees", classifiedBy: "card-fee-interest" }),
      row(gold, "2025-05-05", "AMEX OFFER CREDIT", 30),
      row(gold, "2025-06-05", "POINTS FOR AMEX TRVL", 400),
    ];
    const c = cardOf(build({ accounts: [gold], rows }), "gold");
    expect(c.fee.cents).toBe(32_500);
    expect(c.fee.nextDue).toBe("2026-08-20");
    expect(c.offersCents).toBe(3_000);
    expect(c.credits.find((x) => x.kind === "REDEMPTION")).toBeDefined();
  });

  it("says which card each purchase should have gone on", () => {
    const rows = [row(cash, "2025-03-05", "BISTRO", -100, { category: "Dining" }), row(gold, "2025-03-06", "AMAZON.COM", -100, { category: "Shopping & gifts" })];
    const r = build({ accounts: [gold, cash], rows });
    const dining = r.optimizer.lines.find((l) => l.key === "dining")!;
    expect(dining.best?.accountId).toBe("gold");
    expect(dining.bestCents - dining.actualCents).toBe(300);
    expect(r.optimizer.tips.find((t) => t.key === "online")?.accountId).toBe("cash");
  });
});

describe("settings", () => {
  it("keeps the first version's product choices and drops what it no longer stores", () => {
    const s = normalizeCardPerks({ version: 1, centsPerPoint: 1.5, cards: { a: { productId: "amex-gold", name: "x", perks: [] }, b: { productId: "nope" } }, usage: { "a|uber|2025-01": 1000 } });
    expect(s).toEqual({ version: 2, cards: { a: { productId: "amex-gold", hidden: false } }, pointValues: {} });
  });
});

describe("Uber Cash", () => {
  it("doesn't take an Uber One membership charge as a ride", () => {
    const r = build({ accounts: [gold], rows: [row(gold, "2025-04-08", "UBER ONE HELP.UBER.COM", -96)] });
    expect(period(r, "gold", "uber", "2025-04").status).toBe("MISSED");
  });
});
