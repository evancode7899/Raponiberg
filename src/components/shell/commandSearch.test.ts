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
