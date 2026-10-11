import type { Metadata } from "next";
import { InvestmentsClient } from "./InvestmentsClient";

export const metadata: Metadata = {
  title: "Investments",
  description: "Holdings, allocation, fund costs, unrealized gains and money in vs growth",
};

export const dynamic = "force-dynamic";

export default function InvestmentsPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <InvestmentsClient requiresApiSecret={requiresApiSecret} />;
}
