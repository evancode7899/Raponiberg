import type { Metadata } from "next";
import { CalendarClient } from "./CalendarClient";

export const metadata: Metadata = {
  title: "Money calendar",
  description: "What to do by when, with the amounts: account room before each deadline, estimated tax, the W-4 and April's returns",
};

export const dynamic = "force-dynamic";

export default function CalendarPage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <CalendarClient requiresApiSecret={requiresApiSecret} />;
}
