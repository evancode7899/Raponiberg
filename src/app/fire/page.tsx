import type { Metadata } from "next";
import { FireClient } from "./FireClient";

export const metadata: Metadata = {
  title: "FIRE",
  description: "Financial independence, retire early: FIRE number, FI date, Lean/Coast/Barista/Fat FIRE, levers, stress test and the FIRE playbook",
};

export const dynamic = "force-dynamic";

export default function FirePage() {
  const requiresApiSecret = Boolean(process.env.API_SECRET);
  return <FireClient requiresApiSecret={requiresApiSecret} />;
}
