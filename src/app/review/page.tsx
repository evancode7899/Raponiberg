import { redirect } from "next/navigation";

/** The review queue is on Statements now (its Categorize and Transfers tabs); old links and bookmarks land on the same tab. */
export default async function ReviewRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab } = await searchParams;
  redirect(`/statements?tab=${tab === "transfers" ? "transfers" : "categorize"}`);
}
