import type { Metadata } from "next";
import { TaxClient } from "./TaxClient";

export const metadata: Metadata = {
  title: "Taxes",
  description: "Federal, Connecticut and New York taxes: projections, joint vs separate, withholding true-up",
};

export const dynamic = "force-dynamic";

export default function TaxesPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <TaxClient requiresApiSecret={requiresApiSecret} />;
}
