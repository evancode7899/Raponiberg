import type { Metadata } from "next";
import { MedicalClient } from "./MedicalClient";

export const metadata: Metadata = {
  title: "Medical",
  description: "Medical, dental and vision care from the insurers' explanations of benefits: claims, deductibles, out-of-pocket limits, annual maximums and what each plan covers",
};

export const dynamic = "force-dynamic";

export default function MedicalPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <MedicalClient requiresApiSecret={requiresApiSecret} />;
}
