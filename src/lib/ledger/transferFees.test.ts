import { describe, expect, it } from "vitest";
import { transferDifferenceAdjustments } from "./transferFees";

describe("transferDifferenceAdjustments", () => {
  it("books a lossy transfer's shortfall on the sending leg", () => {
    const m = transferDifferenceAdjustments([
      { differenceCents: -3_725, legs: [{ id: "out", amountCents: -5_003_725 }, { id: "in", amountCents: 5_000_000 }] },
    ]);
    expect([...m]).toEqual([["out", -3_725]]);
  });

  it("uses the largest outflow when several legs leave", () => {
    const m = transferDifferenceAdjustments([
      {
        differenceCents: -100,
        legs: [
          { id: "a", amountCents: -100 },
          { id: "b", amountCents: -9_000 },
          { id: "in", amountCents: 9_000 },
        ],
      },
    ]);
    expect([...m]).toEqual([["b", -100]]);
  });

  it("ignores transfers that net to zero", () => {
    expect(transferDifferenceAdjustments([{ differenceCents: 0, legs: [{ id: "x", amountCents: -1 }, { id: "y", amountCents: 1 }] }]).size).toBe(0);
  });
});
