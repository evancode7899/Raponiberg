import type { Metadata } from "next";
import { TaxAccountsClient } from "./TaxAccountsClient";

export const metadata: Metadata = {
  title: "Account limits",
  description: "How much of each yearly 401(k), IRA, HSA and 529 limit is used, and which to fill next",
};

export const dynamic = "force-dynamic";

export default function TaxAccountsPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <TaxAccountsClient requiresApiSecret={requiresApiSecret} />;
}
