import type { Metadata } from "next";
import { StatementsClient } from "./StatementsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Statements",
  description: "Import statements, search and categorize rows, settle transfers, check coverage, manage documents and accounts",
};

export default function StatementsPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <StatementsClient requiresApiSecret={requiresApiSecret} />;
}
