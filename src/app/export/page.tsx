import { redirect } from "next/navigation";

/** Exports live in Settings › Data & backups. */
export default function ExportPage() {
  redirect("/settings?tab=data");
}
