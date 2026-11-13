import { NextResponse } from "next/server";

/**
 * The gate on browse / export / import / wipe. They are part of the API, so `API_SECRET`
 * (header `x-api-secret`) covers them like every other route; when
 * `SETTINGS_DATABASE_SECRET` is set they also require header
 * `x-settings-database-secret` with the same value. Omit both env vars for local-only use.
 */
export function assertSettingsDatabaseRequest(req: Request): NextResponse | null {
  const apiSecret = process.env.API_SECRET;
  if (apiSecret && req.headers.get("x-api-secret") !== apiSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
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
