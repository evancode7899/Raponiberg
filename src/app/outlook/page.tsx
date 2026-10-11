import { redirect } from "next/navigation";

/**
 * "Profile & outlook" was split up: the outlook is now FIRE, account roll-forwards are on
 * Net worth, and the annual statement and one-off tags are the Annual report. Old links
 * and bookmarks land where their tab went.
 */
export default async function OutlookRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab } = await searchParams;
  redirect(tab === "outlook" ? "/fire" : tab === "accounts" ? "/net-worth?tab=accounts" : tab === "inputs" ? "/annual?tab=one-offs" : "/annual");
}
