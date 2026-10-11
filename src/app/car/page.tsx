import type { Metadata } from "next";
import { CarClient } from "./CarClient";

export const metadata: Metadata = {
  title: "Car",
  description: "Total cost of ownership, cost per mile, fuel economy, depreciation, warranty and service, from your log and the statements",
};

export const dynamic = "force-dynamic";

export default function CarPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <CarClient requiresApiSecret={requiresApiSecret} />;
}
