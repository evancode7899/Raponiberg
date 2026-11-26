import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_TABS, suggest } from "./commandSearch";
import { TERMINAL_COMMANDS } from "./terminalCommands";

/** Where each page keeps its list of tabs. */
const SOURCES: Record<string, string> = {
  "/net-worth": "net-worth/NetWorthClient",
  "/investments": "investments/InvestmentsClient",
  "/fire": "fire/FireClient",
  "/home-budget": "home-budget/HomeBudgetClient",
  "/tax-accounts": "tax-accounts/TaxAccountsClient",
  "/cash-flow": "cash-flow/CashFlowClient",
  "/annual": "annual/AnnualClient",
  "/bonuses": "bonuses/BonusesClient",
  "/taxes": "taxes/TaxClient",
  "/card-perks": "card-perks/CardPerksClient",
  "/car": "car/CarClient",
  "/insurance": "insurance/InsuranceClient",
  "/medical": "medical/MedicalClient",
  "/hsa": "hsa/HsaClient",
  "/statements": "statements/StatementsClient",
  "/settings": "settings/SettingsClient",
};

describe("the command line's tabs", () => {
  it("are each page's own, all but the one it opens on", () => {
    expect(Object.keys(PAGE_TABS).sort()).toEqual(Object.keys(SOURCES).sort());
    for (const [href, file] of Object.entries(SOURCES)) {
      const src = readFileSync(`src/app/${file}.tsx`, "utf8");
      const own = [...src.match(/const TABS = \[([^\]]*)\] as const/)![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(PAGE_TABS[href]!.map(([id]) => id), href).toEqual(own.slice(1));
      expect(TERMINAL_COMMANDS.some((c) => c.href === href), href).toBe(true);
    }
  });
});

const first = (q: string) => suggest(q)[0]!;

describe("what it suggests", () => {
  it("a page by its code or name", () => {
    expect(first("nw").href).toBe("/net-worth");
    expect(first("CF").href).toBe("/cash-flow");
    expect(first("money cal").href).toBe("/calendar");
  });

  it("a tab by a code and words, or by its name alone", () => {
    expect(first("cf trend").href).toBe("/cash-flow?tab=trends");
    expect(first("tax w-4").href).toBe("/taxes?tab=w4");
    expect(suggest("stress test").map((s) => s.href)).toContain("/fire?tab=stress");
  });

  it("a category's rows, alone or under Cash flow", () => {
    expect(first("cf dining").href).toBe("/statements?tab=transactions&category=Dining&lane=EXPENSE");
    expect(suggest("groceries").map((s) => s.id)).toContain("cat:Groceries");
  });

  it("rows that say the words, when asked or when nothing else answers", () => {
    expect(suggest("find springfield power")).toEqual([expect.objectContaining({ href: "/statements?tab=transactions&q=springfield%20power" })]);
    expect(first("springfield power & light").href).toBe("/statements?tab=transactions&q=springfield%20power%20%26%20light");
  });

  it("no search for a bare code, and nothing twice", () => {
    expect(suggest("nw").some((s) => s.code === "FIND")).toBe(false);
    for (const q of ["", "cf", "tax", "s", "plan", "statements"]) {
      const hrefs = suggest(q).map((s) => `${s.href}${s.action ?? ""}`);
      expect(new Set(hrefs).size, q).toBe(hrefs.length);
    }
  });

  it("keeps the shut-down command an action", () => {
    expect(first("off")).toMatchObject({ code: "OFF", action: "shutdown" });
  });
});

const ctx = {
  today: "2031-06-15",
  accounts: [
    { id: "acc1", name: "Example Checking ••1234", institution: "Springfield Bank", archived: false },
    { id: "acc2", name: "Old Savings", institution: null, archived: true },
  ],
  merchants: [
    { key: "SPRINGFIELD GROCER", name: "Springfield Grocer #12", rows: 40 },
    { key: "EXAMPLE PHARMACY", name: "Example Pharmacy", rows: 3 },
  ],
  views: [{ name: "Big dining months", href: "/cash-flow?tab=trends" }],
  pinned: [{ name: "Pat's brokerage", descriptor: { report: "net-worth", metric: "balance" } }],
  figures: [{ name: "Net worth", descriptor: { report: "net-worth", metric: "total" }, shownCents: 123_400 }],
};

describe("what it finds by name", () => {
  it("accounts, merchants and figures; a figure opens its proof, not a page", () => {
    expect(suggest("checking", 14, ctx).map((s) => s.id)).toContain("acct:acc1");
    expect(suggest("acct", 14, ctx).map((s) => s.code)).toEqual(["ACCT", "ACCT"]);
    expect(suggest("merch grocer", 14, ctx)[0]).toMatchObject({ code: "MERCH", href: "/statements?tab=transactions&q=SPRINGFIELD%20GROCER" });
    const nw = suggest("fig net worth", 14, ctx)[0]!;
    expect(nw).toMatchObject({ code: "FIG", href: "", proof: { descriptor: { report: "net-worth", metric: "total" }, shownCents: 123_400 } });
  });

  it("the owner's saved views and pins come first", () => {
    expect(suggest("dining", 14, ctx)[0]).toMatchObject({ code: "VIEW", href: "/cash-flow?tab=trends" });
    expect(suggest("brokerage", 14, ctx)[0]).toMatchObject({ code: "PIN", proof: { descriptor: { report: "net-worth", metric: "balance" } } });
    expect(suggest("", 14, ctx)[0]).toMatchObject({ code: "VIEW" });
  });

  it("SAVE name keeps the view as it is", () => {
    expect(suggest("save Big dining months")).toEqual([expect.objectContaining({ action: "save-view", arg: "Big dining months" })]);
    expect(suggest("save")).toEqual([]);
  });
});

describe("periods", () => {
  it("CF 24M DINING: a category's rows over the last 24 months", () => {
    expect(suggest("cf 24m dining", 14, ctx)[0]!.href).toBe("/statements?tab=transactions&category=Dining&lane=EXPENSE&from=2029-06-15");
  });

  it("a year, YTD and days narrow a search or an account", () => {
    expect(suggest("find 2030 pharmacy", 14, ctx)).toEqual([expect.objectContaining({ href: "/statements?tab=transactions&q=pharmacy&from=2030-01-01&to=2030-12-31" })]);
    expect(suggest("acct ytd checking", 14, ctx)[0]!.href).toBe("/statements?tab=transactions&accountId=acc1&from=2031-01-01");
    expect(suggest("acct 90d checking", 14, ctx)[0]!.href).toBe("/statements?tab=transactions&accountId=acc1&from=2031-03-17");
  });

  it("reads month-ends safely and leaves other words alone", async () => {
    const { periodOf } = await import("./commandSearch");
    expect(periodOf("1m", "2031-03-31")?.from).toBe("2031-02-28");
    expect(periodOf("2y", "2031-02-28")?.from).toBe("2029-02-28");
    expect(periodOf("0m", "2031-03-31")).toBeNull();
    expect(periodOf("dining", "2031-03-31")).toBeNull();
  });
});

describe("split view", () => {
  it("SPLIT code puts that page beside this one, SPLIT alone closes it", () => {
    expect(suggest("split tax")[0]).toMatchObject({ code: "SPLIT", action: "split", href: "/taxes" });
    expect(suggest("split cf trends")[0]).toMatchObject({ action: "split", href: "/cash-flow?tab=trends" });
    expect(suggest("split")[0]).toMatchObject({ action: "split", href: "" });
  });
});

describe("tour", () => {
  it("TOUR starts the guided tour rather than opening a page", () => {
    expect(suggest("tour")[0]).toMatchObject({ code: "TOUR", action: "tour" });
  });
});
