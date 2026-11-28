import type { Metadata } from "next";
import { cashFlowPayload, firstData } from "@/lib/cashFlowPayload";
import { prisma } from "@/lib/db";
import { CashFlowClient } from "./CashFlowClient";

export const metadata: Metadata = {
  title: "Cash flow",
  description: "Spending, merchants, recurring bills, budget and income — every proven month, from statements",
};

export const dynamic = "force-dynamic";

/**
 * The page comes with its first data (the report without its merchant lists, as the client
 * would ask for it): drawn at once, never a blank page waiting on a fetch. Not when an access
 * secret guards the data: then only the API, with the secret, hands it out.
 */
export default async function CashFlowPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  const path = "/api/dashboard/cash-flow?parts=lean";
  const first = requiresApiSecret ? null : await cashFlowPayload(prisma, undefined, "lean").then((b) => firstData(path, b)).catch(() => null);
  return <CashFlowClient requiresApiSecret={requiresApiSecret} first={first} />;
}
