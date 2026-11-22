import { redirect } from "next/navigation";

/** Prepay vs invest is a tab of Home & mortgage now; old links and bookmarks land on it. */
export default function MortgageRedirect() {
  redirect("/home-budget?tab=mortgage");
}
