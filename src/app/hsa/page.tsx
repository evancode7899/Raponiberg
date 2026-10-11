import type { Metadata } from "next";
import { HsaClient } from "./HsaClient";

export const metadata: Metadata = {
  title: "HSA receipts",
  description: "Medical bills paid out of pocket that the HSA can reimburse tax-free whenever you choose, and what leaving the money invested has earned",
};

export const dynamic = "force-dynamic";

export default function HsaPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <HsaClient requiresApiSecret={requiresApiSecret} />;
}
