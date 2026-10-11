import type { Metadata } from "next";
import { HomeBudgetClient } from "./HomeBudgetClient";

export const metadata: Metadata = {
  title: "Home budget",
  description: "Home affordability and rent vs buy",
};

export const dynamic = "force-dynamic";

export default function HomeBudgetPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <HomeBudgetClient requiresApiSecret={requiresApiSecret} />;
}
