import type { Metadata } from "next";
import { SettingsClient } from "./SettingsClient";

export const metadata: Metadata = {
  title: "Settings",
  description: "Appearance, app password, household, exports, backups and the audit log",
};

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <SettingsClient
      requiresApiSecret={Boolean(process.env.API_SECRET)}
      requiresDbSecret={Boolean(process.env.SETTINGS_DATABASE_SECRET?.trim())}
    />
  );
}
