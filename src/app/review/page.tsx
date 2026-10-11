import type { Metadata } from "next";
import { ReviewClient } from "./ReviewClient";

export const metadata: Metadata = {
  title: "Review",
  description: "Categorize uncertain rows and settle transfers",
};

export const dynamic = "force-dynamic";

export default function ReviewPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <ReviewClient requiresApiSecret={requiresApiSecret} />;
}
