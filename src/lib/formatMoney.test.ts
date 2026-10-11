import { describe, expect, it } from "vitest";
import {
  EM_DASH,
  formatPercentRatio,
  formatUsd,
  formatUsdCents,
  formatUsdFromCents,
} from "./formatMoney";

describe("formatUsd", () => {
  it("uses parentheses for negatives", () => {
    expect(formatUsd(-100)).toBe("($100)");
  });

  it("uses em dash for exact zero", () => {
    expect(formatUsd(0)).toBe(EM_DASH);
  });

  it("groups thousands", () => {
    expect(formatUsd(285000)).toBe("$285,000");
  });
});

describe("formatUsdCents", () => {
  it("formats cents with optional decimals", () => {
    expect(formatUsdCents(100_00)).toBe("$100");
    expect(formatUsdCents(-250)).toBe("($2.50)");
    expect(formatUsdCents(505610)).toBe("$5,056.10");
  });

  it("zero cents is em dash", () => {
    expect(formatUsdCents(0)).toBe(EM_DASH);
  });
});

describe("formatUsdFromCents", () => {
  it("uses two decimals", () => {
    expect(formatUsdFromCents(123)).toBe("$1.23");
  });

  it("zero is em dash", () => {
    expect(formatUsdFromCents(0)).toBe(EM_DASH);
  });
});

describe("formatPercentRatio", () => {
  it("parentheses for negative", () => {
    expect(formatPercentRatio(-0.05)).toBe("(5%)");
  });

  it("em dash for zero", () => {
    expect(formatPercentRatio(0)).toBe(EM_DASH);
  });
});
