import type { Metadata } from "next";
import { BonusesClient } from "./BonusesClient";

export const metadata: Metadata = {
  title: "Bonuses",
  description: "Headline bonuses, what was paid up front, what was deferred, and when the rest vests",
};

export const dynamic = "force-dynamic";

export default function BonusesPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <BonusesClient requiresApiSecret={requiresApiSecret} />;
}
