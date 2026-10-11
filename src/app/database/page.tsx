import type { Metadata } from "next";
import { DatabaseBrowserClient } from "./DatabaseBrowserClient";

export const metadata: Metadata = {
  title: "Database browser",
  description: "Browse SQLite tables",
};

export default function DatabasePage() {
  const requiresDbSecret = Boolean(process.env.SETTINGS_DATABASE_SECRET?.trim());
  return <DatabaseBrowserClient requiresDbSecret={requiresDbSecret} />;
}
