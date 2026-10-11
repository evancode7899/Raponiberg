import type { Metadata } from "next";
import { AnnualClient } from "./AnnualClient";

export const metadata: Metadata = {
  title: "Annual report",
  description: "Each calendar year: pay, taxes, spending and savings, year-end net worth, and what moved it; one-off expenses",
};

export const dynamic = "force-dynamic";

export default function AnnualPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <AnnualClient requiresApiSecret={requiresApiSecret} />;
}
