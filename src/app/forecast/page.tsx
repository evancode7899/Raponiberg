import type { Metadata } from "next";
import { ForecastClient } from "./ForecastClient";

export const metadata: Metadata = {
  title: "Forecast",
  description: "The engine FIRE, Taxes, Home budget and Goals run on: drivers in, a month-by-month path out, tied to what is proven so far",
};

export const dynamic = "force-dynamic";

export default function ForecastPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <ForecastClient requiresApiSecret={requiresApiSecret} />;
}
