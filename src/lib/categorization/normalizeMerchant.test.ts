import { describe, expect, it } from "vitest";
import { normalizeMerchant } from "./normalizeMerchant";

describe("normalizeMerchant", () => {
  it("uppercases and trims", () => {
    expect(normalizeMerchant("  Hulu.com/bill  ")).toBe("HULU COM BILL");
  });

  it("strips a leading AplPay card-network prefix", () => {
    expect(normalizeMerchant("AplPay Harbor Flavor by My")).toBe(
      "HARBOR FLAVOR BY MY",
    );
  });

  it("strips trailing long digit strings (terminal/reference numbers)", () => {
    expect(normalizeMerchant("Pizza Place 436845559996870")).toBe("PIZZA PLACE");
  });

  it("collapses asterisks used as merchant/aggregator separators", () => {
    expect(normalizeMerchant("GOOGLE *YOUTUBEPREMIUM")).toBe("GOOGLE YOUTUBEPREMIUM");
  });

  it("produces the same key for the same merchant with different noise", () => {
    const a = normalizeMerchant("AplPay UBER *TRIP 8005928996");
    const b = normalizeMerchant("UBER *TRIP");
    expect(a).toBe(b);
  });
});
