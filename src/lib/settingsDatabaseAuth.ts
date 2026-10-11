import { NextResponse } from "next/server";

/**
 * When `SETTINGS_DATABASE_SECRET` is set, export / import / wipe require header
 * `x-settings-database-secret` with the same value. Omit the env var for local-only use.
 */
export function assertSettingsDatabaseRequest(req: Request): NextResponse | null {
  const secret = process.env.SETTINGS_DATABASE_SECRET?.trim();
  if (!secret) {
    return null;
  }
  const h = req.headers.get("x-settings-database-secret");
  if (h !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
