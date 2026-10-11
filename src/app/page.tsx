import type { Metadata } from "next";
import { HomeClient } from "./HomeClient";

export const metadata: Metadata = {
  title: { absolute: "Dashboard · Raponiberg" },
  description: "Net worth, cash flow and what needs attention",
};

export const dynamic = "force-dynamic";

export default function Home() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <HomeClient requiresApiSecret={requiresApiSecret} />;
}
