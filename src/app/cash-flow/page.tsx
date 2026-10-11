import type { Metadata } from "next";
import { CashFlowClient } from "./CashFlowClient";

export const metadata: Metadata = {
  title: "Cash flow",
  description: "Spending, merchants, recurring bills, budget and income — every proven month, from statements",
};

export const dynamic = "force-dynamic";

export default function CashFlowPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <CashFlowClient requiresApiSecret={requiresApiSecret} />;
}
