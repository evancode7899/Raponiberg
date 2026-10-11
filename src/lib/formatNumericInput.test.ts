import { describe, expect, it } from "vitest";
import {
  clampInt,
  formatIntegerDisplay,
  fractionDigitsForStep,
  parseIntegerInput,
} from "./formatNumericInput";

describe("formatIntegerDisplay", () => {
  it("adds grouping", () => {
    expect(formatIntegerDisplay(285000)).toBe("285,000");
  });

  it("strips non-finite", () => {
    expect(formatIntegerDisplay(Number.NaN)).toBe("");
  });
});

describe("parseIntegerInput", () => {
  it("parses comma-separated", () => {
    expect(parseIntegerInput("1,234,567")).toBe(1234567);
  });

  it("drops leading zeros in parse", () => {
    expect(parseIntegerInput("0004500")).toBe(4500);
  });
});

describe("clampInt", () => {
  it("respects bounds", () => {
    expect(clampInt(5, 10, 20)).toBe(10);
    expect(clampInt(99, 0, 50)).toBe(50);
  });
});

describe("fractionDigitsForStep", () => {
  it("infers decimals from step", () => {
    expect(fractionDigitsForStep(1)).toBe(0);
    expect(fractionDigitsForStep(0.25)).toBe(2);
    expect(fractionDigitsForStep(0.125)).toBe(3);
  });
});
