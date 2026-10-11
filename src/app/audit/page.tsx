import { redirect } from "next/navigation";

/** The audit log lives in Settings › Audit log. */
export default function AuditPage() {
  redirect("/settings?tab=audit");
}
