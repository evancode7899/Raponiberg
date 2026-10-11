import { NextRequest } from "next/server";

/**
 * Local API gate (dashboard, export, transactions, shutdown). When `API_SECRET` is set,
 * require the `x-api-secret` header to match.
 */
export function checkApiAuth(request: NextRequest): boolean {
  const secret = process.env.API_SECRET;
  if (!secret) {
    return true;
  }
  return request.headers.get("x-api-secret") === secret;
}
