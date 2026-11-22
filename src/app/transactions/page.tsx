import { redirect } from "next/navigation";

/** Transactions is a tab of Statements now; old links and bookmarks keep their filters (?accountId=, ?category=, …). */
export default async function TransactionsRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (k === "tab") continue;
    for (const one of Array.isArray(v) ? v : v == null ? [] : [v]) sp.append(k, one);
  }
  sp.set("tab", "transactions");
  redirect(`/statements?${sp}`);
}
