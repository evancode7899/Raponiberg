import { describe, expect, it } from "vitest";
import { drawdown } from "./drawdown";

const p = (rs: (number | null)[]) => rs.map((r, i) => ({ label: `M${i + 1}`, r }));

describe("drawdown", () => {
  it("finds the deepest fall from a high, and where it stands now", () => {
    // Up 10%, down 20%, up 5%: the high is M1 (1.10), the trough M2 (0.88), now 0.924.
    const d = drawdown(p([0.1, -0.2, 0.05]))!;
    expect(d.max).toMatchObject({ peak: "M1", trough: "M2" });
    expect(d.max!.ratio).toBeCloseTo(-0.2, 10);
    expect(d.now.peak).toBe("M1");
    expect(d.now.ratio).toBeCloseTo(0.924 / 1.1 - 1, 10);
  });

  it("is at zero at a new high, skips periods without a return, and has no fall when it only rises", () => {
    const d = drawdown(p([0.02, null, 0.03]))!;
    expect(d.max).toBeNull();
    expect(d.now).toEqual({ ratio: 0, peak: "M3" });
    expect(drawdown([])).toBeNull();
  });

  it("counts a fall in the very first period from the start", () => {
    const d = drawdown(p([-0.05]))!;
    expect(d.max!.ratio).toBeCloseTo(-0.05, 10);
    expect(d.max!.peak).toBeNull();
  });
});
