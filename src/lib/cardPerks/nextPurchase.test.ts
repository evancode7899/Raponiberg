import { describe, expect, it } from "vitest";
import type { WalletTip } from "./types";
import { nextPurchase, purchaseType } from "./nextPurchase";

const tip = (key: string, accountId: string): WalletTip => ({ key, label: key, accountId, rate: 3, centsPerDollar: 3, runnerUp: null });
const tips = [tip("dining", "card-a"), tip("groceries", "card-b"), tip("flights", "card-c"), tip("other", "card-d")];

describe("the next purchase", () => {
  it("reads a kind by name, a category from its words, or a merchant pattern", () => {
    expect(purchaseType("flights")?.key).toBe("flights");
    expect(purchaseType("Hotels")?.key).toBe("hotels");
    expect(purchaseType("coffee shop")?.key).toBe("dining");
    expect(purchaseType("whole foods")?.key).toBe("groceries");
    expect(purchaseType("uber")?.key).toBe("rides");
    expect(purchaseType("netflix")?.key).toBe("streaming");
    expect(purchaseType("amazon")?.key).toBe("online");
    expect(purchaseType("a lamp at a furniture store")?.key).toBe("other");
  });

  it("answers with the kind's card, or the card for everything else", () => {
    expect(nextPurchase("dinner out", tips)?.tip.accountId).toBe("card-a");
    expect(nextPurchase("uber", tips)?.tip.accountId).toBe("card-d");
    expect(nextPurchase("x", tips)).toBeNull();
    expect(nextPurchase("dinner", [])).toBeNull();
  });
});
