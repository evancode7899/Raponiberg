import type { CardPerksReport } from "../../cardPerks/types.ts";
import { c, ln, r, t, type DerivedFigure } from "./types.ts";

/** The Card perks headline for one year (key: the year): net value, rewards, credits used, perk capture and what's still to use. */
export function cardPerksDerived(rep: Pick<CardPerksReport, "year" | "totals" | "cards">): DerivedFigure[] {
  const x = rep.totals;
  const key = String(rep.year);
  const f = (figure: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"]): DerivedFigure => ({ figure, key, describes: `${describes}, ${rep.year}`, value, lines });
  return [
    f("net-value", "Net value of the cards", c(x.netCents), [
      ln("Rewards earned", c(x.rewardsValueCents), undefined, { source: "proven" }),
      ln("Perk credits used", c(x.perksValueCents), "+", { source: "proven" }),
      ln("Offers & bonuses", c(x.offersCents), "+", { source: "proven" }),
      ln("Annual fees", c(x.feesCents), "−", { source: "proven" }),
      ln("Net value", c(x.netCents), "="),
    ]),
    f("rewards", "Rewards earned", c(x.rewardsValueCents), [ln("Card spending", c(x.spendCents), undefined, { source: "proven" }), ln("Rewards, as the statements print them (or expected where none print)", c(x.rewardsValueCents))]),
    f("credits", "Credits used: perks, offers and bonuses", c(x.perksValueCents + x.offersCents), [ln("Perk credits", c(x.perksValueCents), undefined, { source: "proven" }), ln("Offers & bonuses", c(x.offersCents), "+", { source: "proven" }), ln("Credits used", c(x.perksValueCents + x.offersCents), "=")]),
    f("capture", "Perk capture: credits used of those available", x.captureRate == null ? null : r(x.captureRate), [ln("Credits used", c(x.perksValueCents)), ln("Let lapse", c(x.missedCents)), ln("Capture", x.captureRate == null ? t("—") : r(x.captureRate))]),
    f("remaining", "Credits still to use", c(x.remainingCents), [ln("Open credits", t(String(x.openPerks))), ln("Still to use", c(x.remainingCents))]),
  ];
}
