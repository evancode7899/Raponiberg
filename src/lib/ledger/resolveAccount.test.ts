import { describe, expect, it } from "vitest";
import type { ParsedAccountSection } from "../ingest/types";
import { cardHolder, displayName } from "./resolveAccount";

// An invented household: Pat Example and Lee Example. Every name and number is made up.
const PERSONS = [
  { name: "Pat Example", match: ["PAT"] },
  { name: "Lee Example", match: ["LEE"] },
];

const card = (members: (string | undefined)[], kind: ParsedAccountSection["kind"] = "CREDIT_CARD"): ParsedAccountSection => ({
  institution: "Example Bank",
  accountNumber: "4321",
  accountName: "Example Rewards Card",
  kind,
  subtype: "CREDIT_CARD",
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  openingBalanceCents: 0,
  closingBalanceCents: 0,
  growthCents: 0,
  feesCents: 0,
  checks: [],
  transactions: members.map((m, i) => ({ date: "2026-01-05", datePrecision: "EXACT", description: `CHARGE ${i}`, amountCents: -1_000, cardMember: m })),
});

describe("a card's holder, from the card-member names it prints", () => {
  it("names the one member every row names", () => {
    const s = card(Array.from({ length: 10 }, () => "LEE A EXAMPLE"));
    expect(cardHolder(s, PERSONS)).toBe("Lee");
    expect(displayName(s, cardHolder(s, PERSONS))).toBe("Example Rewards Card — Lee ••4321");
  });

  it("allows a few unnamed rows, not a card two people use or one that rarely names anyone", () => {
    expect(cardHolder(card([...Array.from({ length: 19 }, () => "LEE EXAMPLE"), undefined]), PERSONS)).toBe("Lee");
    expect(cardHolder(card(["LEE EXAMPLE", "PAT EXAMPLE", "LEE EXAMPLE"]), PERSONS)).toBeNull();
    expect(cardHolder(card(["LEE EXAMPLE", undefined, undefined]), PERSONS)).toBeNull();
    expect(cardHolder(card(["SOMEONE ELSE", "SOMEONE ELSE"]), PERSONS)).toBeNull();
  });

  it("only reads cards", () => {
    expect(cardHolder(card(["LEE EXAMPLE"], "CHECKING"), PERSONS)).toBeNull();
    expect(displayName(card([]))).toBe("Example Rewards Card ••4321");
  });
});
