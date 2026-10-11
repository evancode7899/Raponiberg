import type { Metadata } from "next";
import { NetWorthClient } from "./NetWorthClient";

export const metadata: Metadata = {
  title: "Net worth",
  description: "Net worth from statements: composition, how it was built, investment returns",
};

export const dynamic = "force-dynamic";

export default function NetWorthPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <NetWorthClient requiresApiSecret={requiresApiSecret} />;
}
