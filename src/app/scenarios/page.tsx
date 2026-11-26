import type { Metadata } from "next";
import { ScenariosClient } from "./ScenariosClient";

export const metadata: Metadata = {
  title: "Scenarios",
  description: "Today's plan beside what-ifs: pay, children, buying a home, spending. Cash flow, taxes, net worth, FI date and goals, side by side",
};

export const dynamic = "force-dynamic";

export default function ScenariosPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <ScenariosClient requiresApiSecret={requiresApiSecret} />;
}
