import type { Metadata } from "next";
import { GoalsClient } from "./GoalsClient";

export const metadata: Metadata = {
  title: "Goals",
  description: "Savings targets funded from real balances: progress, pace and when you'll get there",
};

export const dynamic = "force-dynamic";

export default function GoalsPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <GoalsClient requiresApiSecret={requiresApiSecret} />;
}
