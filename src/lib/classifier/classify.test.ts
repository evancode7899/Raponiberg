import { describe, expect, it } from "vitest";
import { compileHousehold } from "../household/patterns.ts";
import { classifyTransaction, type ClassifyInput } from "./classify.ts";
import { categorizeMerchant, merchantKey } from "./merchants.ts";

// A made-up household: Pat Example and partner Sam Sample, whose own TD account ends 9999.
const household = compileHousehold({
  version: 1,
  cardholderNames: "(PAT|SAM) (Q )?(EXAMPLE|SAMPLE)",
  partner: { cardPattern: "\\bSAM\\b|SAMPLE", accountPattern: "TD BANK.*X+9999\\b", transferPattern: "ZELLE PAYMENT (FROM|TO) SAM\\b|SAMPLE" },
  merchantKeywords: { "dining-places": "MAISON ZEPHYR" },
});
const ctx = { mergeDate: "2024-12-01", userRules: [], household };
const hysa = (description: string, dollars: number, date = "2026-07-28"): ClassifyInput => ({
  institution: "American Express",
  accountSubtype: "SAVINGS",
  description,
  amountCents: Math.round(dollars * 100),
  date,
});

describe("Amex High Yield Savings rows", () => {
  it("treats an external ACH to the joint checking as an own-account transfer naming that account", () => {
    const c = classifyTransaction(
      hysa("External ACH Withdrawal Express Internet transfer to JPMORGAN CHASE BANK, NA DDA account XXXXX1234 Sam Sample", -350),
      ctx,
    );
    expect(c.lane).toBe("TRANSFER");
    expect(c.ruleId).toBe("savings-ach");
    expect(c.counterparty.accountHint).toBe("1234");
  });

  it("treats money from the partner's own TD account as partner money", () => {
    const c = classifyTransaction(hysa("External ACH Deposit Internet transfer from TD BANK NA DDA account XXXXXX9999", 5000, "2025-03-28"), ctx);
    expect(c.lane).toBe("EXTERNAL_TRANSFER");
    expect(c.counterparty.kind).toBe("PARTNER");
  });

  it("knows no partner without a household file", () => {
    const c = classifyTransaction(hysa("External ACH Deposit Internet transfer from TD BANK NA DDA account XXXXXX9999", 5000, "2025-03-28"), { mergeDate: "2024-12-01", userRules: [] });
    expect(c.counterparty.kind).not.toBe("PARTNER");
  });
});

describe("untracked card payments", () => {
  const bank = (description: string, dollars: number): ClassifyInput => ({
    institution: "Chase",
    accountSubtype: "CHECKING",
    description,
    amountCents: Math.round(dollars * 100),
    date: "2026-07-20",
  });

  it("files an Elan (Fidelity Visa) payment as an untracked card payment, not for review", () => {
    const c = classifyTransaction(bank("Elan Web Pymt ***********9876 Web ID: 1234567890", -512.34), ctx);
    expect(c).toMatchObject({ lane: "EXPENSE", ruleId: "bank-untracked-card", category: "Untracked card payments" });
    expect(c.counterparty.kind).toBe("UNTRACKED_CARD");
    expect(c.needsReview).toBe(false);
  });

  it("leaves merchants that merely contain ELAN alone", () => {
    expect(classifyTransaction(bank("ZAZZLE IRELANDCORKCO", -20), ctx).ruleId).not.toBe("bank-untracked-card");
  });
});

describe("the household file", () => {
  it("files Zelle with the partner and the partner's card payments as partner money", () => {
    const zelle = classifyTransaction({ institution: "Chase", accountSubtype: "CHECKING", description: "Zelle Payment To Sam 123456", amountCents: -10_000, date: "2025-03-01" }, ctx);
    expect(zelle).toMatchObject({ lane: "EXTERNAL_TRANSFER", ruleId: "bank-partner", category: "Partner accounts (untracked)" });
    const card = classifyTransaction({ institution: "American Express", accountSubtype: "CREDIT_CARD", section: "Payments", description: "PAYMENT RECEIVED SAM SAMPLE", amountCents: 10_000, date: "2024-01-01" }, ctx);
    expect(card).toMatchObject({ lane: "EXTERNAL_TRANSFER", ruleId: "card-payment-partner", category: "Partner contributions (pre-merge)" });
  });

  it("strips the household's names from merchant keys and adds its local merchants", () => {
    expect(merchantKey("PAT Q EXAMPLE SHAKE SHACK", household.cardholderPrefix)).toBe(merchantKey("SHAKE SHACK"));
    expect(categorizeMerchant("MAISON ZEPHYR", undefined, household.merchantRules)).toBe("Dining");
    expect(categorizeMerchant("MAISON ZEPHYR")).toBe(null);
  });

  it("names the bad field of a damaged file", () => {
    expect(() => compileHousehold({ version: 1, merchantKeywords: { nowhere: "X" } })).toThrow(/merchantKeywords\.nowhere/);
    expect(() => compileHousehold({ version: 1, partner: { cardPattern: "(" } })).toThrow(/partner\.cardPattern/);
  });
});

describe("merchant keywords on raw card-network descriptors", () => {
  it.each([
    ["UNITED 01600000000001UNITED.COMTX", "Travel"],
    ["DELTA 00600000000002DELTA.COMCA", "Travel"],
    ["NJT MOBILE 3000000-2700000NJ", "Transportation"],
    ["HELP.MAX.COMNEW YORKNY", "Subscriptions"],
    ["240609 CITY YMCA #SPRINGFIELDMA", "Health & fitness"],
    ["LIDO BEACH RISTORANROMARM", "Dining"],
  ])("%s → %s", (description, category) => {
    expect(categorizeMerchant(description)).toBe(category);
  });

  it("doesn't read 'pita' inside hospital or Milpitas", () => {
    expect(categorizeMerchant("SPRINGFIELD HOSPITAL SPRINGFIELD MA")).toBe("Health & fitness");
    expect(categorizeMerchant("VALLEY PET HOSPITAL 000000001 SPRINGFIELD MA")).toBe("Pets");
    expect(categorizeMerchant("XY HOSPITALITY FOOD AN SPRINGFIELD MA")).toBe("Dining");
    expect(categorizeMerchant("SP ACME GADGETS MILPITAS CA")).toBeNull();
  });
});

describe("Trump Account deposits from the bank", () => {
  it("pairs a debit-card deposit with the Trump Account, and leaves a look-alike merchant alone", () => {
    const deposit = classifyTransaction(
      { institution: "Chase", accountSubtype: "CHECKING", description: "Payment Sent 03/02 Trump Account Deposi Trumpaccounts FL Card 1111", amountCents: -2_500, date: "2026-03-02" },
      ctx,
    );
    expect(deposit).toMatchObject({ lane: "TRANSFER", ruleId: "bank-trump-account" });
    expect(deposit.counterparty).toMatchObject({ kind: "OWN_ACCOUNT", institution: "Trump Account" });
    const trumpet = classifyTransaction({ institution: "Chase", accountSubtype: "CHECKING", description: "ACME TRUMPET SUPPLY 800-555-0100", amountCents: -2_500, date: "2026-03-02" }, ctx);
    expect(trumpet.ruleId).not.toBe("bank-trump-account");
  });
});
