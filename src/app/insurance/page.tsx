import type { Metadata } from "next";
import { InsuranceClient } from "./InsuranceClient";

export const metadata: Metadata = {
  title: "Insurance",
  description: "Each life insurance policy read from its policy packet: coverage, premiums by year, key dates, terms and the premiums paid",
};

export const dynamic = "force-dynamic";

export default function InsurancePage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <InsuranceClient requiresApiSecret={requiresApiSecret} />;
}
