import type { Metadata } from "next";
import { CardPerksClient } from "./CardPerksClient";

export const metadata: Metadata = {
  title: "Card perks",
  description: "Each credit card's annual fee against the credits you used and the points you earned, period by period, from the statements",
};

export const dynamic = "force-dynamic";

export default function CardPerksPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <CardPerksClient requiresApiSecret={requiresApiSecret} />;
}
