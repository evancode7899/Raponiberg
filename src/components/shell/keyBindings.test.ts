import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { csvOfCells, JUMPS, jumpTo, keySections, PAGE_KEYS, stepTab } from "./keyBindings";
import { PAGE_TABS } from "./commandSearch";
import { APP_KEYS, CATEGORIZE_KEYS, DASHBOARD_KEYS, TABLE_KEYS } from "./shortcuts";
import { TERMINAL_COMMANDS } from "./terminalCommands";

/** Where each page with tabs draws them (as in commandSearch.test.ts). */
const TAB_SOURCES: Record<string, string> = {
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

describe("the key map", () => {
  it("every page in the sidebar has a jump, and every jump is a page", () => {
    const pages = TERMINAL_COMMANDS.filter((c) => !c.hidden && !c.action).map((c) => c.href);
    const jumped = new Set(Object.values(JUMPS));
    for (const href of pages) expect(jumped.has(href), href).toBe(true);
    for (const href of jumped) expect(TERMINAL_COMMANDS.some((c) => c.href === href), href).toBe(true);
  });

  it("no two jumps share a letter, and a letter jumps in either case", () => {
    const letters = Object.keys(JUMPS);
    expect(new Set(letters.map((l) => l.toLowerCase())).size).toBe(letters.length);
    expect(jumpTo("N")).toBe("/net-worth");
    expect(jumpTo("?")).toBeNull();
  });

  it("[ and ] step round any page's tab strip, which every page with tabs draws with the kit", () => {
    expect(stepTab(4, 0, 1)).toBe(1);
    expect(stepTab(4, 3, 1)).toBe(0);
    expect(stepTab(4, 0, -1)).toBe(3);
    expect(stepTab(4, -1, 1)).toBe(0);
    expect(stepTab(0, 0, 1)).toBe(-1);
    expect(Object.keys(TAB_SOURCES).sort()).toEqual(Object.keys(PAGE_TABS).sort());
    for (const [href, file] of Object.entries(TAB_SOURCES)) expect(readFileSync(`src/app/${file}.tsx`, "utf8"), href).toMatch(/<Tabs\b/);
  });

  it("each list of keys says each key once, and pages' own keys are the ones they handle", () => {
    for (const list of [APP_KEYS, TABLE_KEYS, DASHBOARD_KEYS, CATEGORIZE_KEYS]) {
      const keys = list.map(([k]) => k);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(PAGE_KEYS.map((p) => p.keys)).toEqual([DASHBOARD_KEYS, CATEGORIZE_KEYS]);
    expect(keySections("/", null).map((s) => s.title)).toEqual(["Anywhere", "In a table", "Dashboard"]);
    expect(keySections("/statements", "categorize").at(-1)!.keys).toBe(CATEGORIZE_KEYS);
    expect(keySections("/statements", "documents")).toHaveLength(2);
  });

  it("Help and the ? overlay draw them from here", () => {
    const help = readFileSync("src/app/help/page.tsx", "utf8");
    for (const name of ["APP_KEYS", "TABLE_KEYS", "JUMPS", "DASHBOARD_KEYS", "CATEGORIZE_KEYS"]) expect(help, name).toContain(name);
    expect(readFileSync("src/components/shell/KeyMap.tsx", "utf8")).toContain("keySections(");
    expect(readFileSync("src/components/shell/AppShell.tsx", "utf8")).toContain("<KeyMap />");
  });

  it("copies a drawn table as CSV", () => {
    expect(csvOfCells(["Date", "Amount"], [["Jun 30, 2031", "$12.30"], ["Jul 1, 2031", "n.a."]])).toBe("Date,Amount\r\nJun 30, 2031,$12.30\r\nJul 1, 2031,n.a.\r\n".replace("Jun 30, 2031", '"Jun 30, 2031"').replace("Jul 1, 2031", '"Jul 1, 2031"'));
  });
});

describe("the sidebar's groups", () => {
  it("Protection holds Insurance, Medical and HSA, and every page is still listed", () => {
    const protection = TERMINAL_COMMANDS.filter((c) => c.group === "Protection").map((c) => c.mnemonic);
    expect(protection).toEqual(["INS", "MED", "HSA"]);
    for (const href of ["/insurance", "/medical", "/hsa"]) expect(Object.values(JUMPS)).toContain(href);
  });
});
