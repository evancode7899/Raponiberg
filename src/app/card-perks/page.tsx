import type { Metadata } from "next";
import { CardPerksClient } from "./CardPerksClient";

export const metadata: Metadata = {
  title: "Card perks",
  description: "Each credit card's fee against the rewards its statements report and every credit it paid, found automatically, with the best card for each purchase",
};

export const dynamic = "force-dynamic";

export default function CardPerksPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <CardPerksClient requiresApiSecret={requiresApiSecret} />;
}
