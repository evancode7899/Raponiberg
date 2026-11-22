import type { Metadata } from "next";
import { HomeBudgetClient } from "./HomeBudgetClient";

export const metadata: Metadata = {
  title: "Home & mortgage",
  description: "Home affordability, rent vs buy, and prepaying the mortgage vs investing",
};

export const dynamic = "force-dynamic";

export default function HomeBudgetPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <HomeBudgetClient requiresApiSecret={requiresApiSecret} />;
}
