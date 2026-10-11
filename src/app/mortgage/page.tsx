import type { Metadata } from "next";
import { MortgageClient } from "./MortgageClient";

export const metadata: Metadata = {
  title: "Mortgage",
  description: "Prepay the mortgage or invest the difference",
};

export default function MortgagePage() {
  return <MortgageClient />;
}
