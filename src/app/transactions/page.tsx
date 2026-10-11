import type { Metadata } from "next";
import { TransactionsClient } from "./TransactionsClient";

export const metadata: Metadata = {
  title: "Transactions",
  description: "Search and recategorize every statement row",
};

export const dynamic = "force-dynamic";

export default function TransactionsPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <TransactionsClient requiresApiSecret={requiresApiSecret} />;
}
