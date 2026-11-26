"use client";

import { Drawer } from "@/components/ui/kit";
import { notify } from "@/components/ui/Feedback";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { COPY_TABLE_EVENT, csvOfCells, isTyping, JUMPS, jumpTo, keySections, stepTab } from "./keyBindings";
import { TERMINAL_COMMANDS } from "./terminalCommands";


const G_WAIT_MS = 1500;

/** The rows J and K move through: every table row drawn, top to bottom (a shared table moves through its own once one has focus). */
function pageRows(): HTMLElement[] {
  const main = document.getElementById("main");
  if (!main) return [];
  return [...main.querySelectorAll<HTMLElement>("tbody > tr")].filter((tr) => !tr.closest("[data-panel], [role='dialog']") && tr.getAttribute("aria-hidden") !== "true" && tr.getClientRects().length > 0);
}

/** A cell as the page draws it: its figures' text when it holds figures (n.a. while withheld), otherwise its words. */
function cellText(td: HTMLElement): string {
  const figs = [...td.querySelectorAll<HTMLElement>("[data-proof-key]")];
  if (figs.length) return figs.map((f) => f.innerText.trim()).join(" ");
  return td.innerText.replace(/\s*\n\s*/g, " · ").trim();
}

/** Copies a table as it's drawn. */
async function copyTable(t: HTMLTableElement) {
  const wrap = t.closest<HTMLElement>("[data-table]");
  if (wrap) return void wrap.dispatchEvent(new Event(COPY_TABLE_EVENT));
  const head = [...t.querySelectorAll<HTMLElement>("thead tr:last-child > th")].map((th) => th.innerText.trim());
  const rows = [...t.querySelectorAll<HTMLElement>("tbody > tr")].filter((tr) => tr.getAttribute("aria-hidden") !== "true").map((tr) => [...tr.querySelectorAll<HTMLElement>(":scope > td, :scope > th")].map(cellText));
  try {
    await navigator.clipboard.writeText(csvOfCells(head, rows));
    notify(`Copied ${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"} as CSV, as the page shows them.`);
  } catch {
    notify("The browser didn't allow copying.", { tone: "bad" });
  }
}

/**
 * The app's keys (keymap.ts lists them): G then a letter jumps to a page, [ and ] step through
 * a page's tabs, J and K through a table's rows (Enter opens one), C copies the table, and ?
 * shows the keys for where you are. A page's own keys go first: anything a page handles
 * (preventDefault) is left alone, and nothing here takes a key typed in a field.
 */
export function KeyMap() {
  const router = useRouter();
  const pathname = usePathname();
  const [help, setHelp] = useState(false);
  const [waitingG, setWaitingG] = useState(false);
  const g = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerTable = useRef<HTMLTableElement | null>(null);

  useEffect(() => {
    const over = (e: PointerEvent) => {
      pointerTable.current = (e.target as Element | null)?.closest?.("main table") ?? null;
    };
    const clearG = () => {
      if (g.current) clearTimeout(g.current);
      g.current = null;
      setWaitingG(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(document.activeElement) || document.querySelector("[role='alertdialog']")) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (g.current) {
        clearG();
        const to = jumpTo(key);
        if (to) {
          e.preventDefault();
          router.push(to);
        }
        return;
      }
      if (key === "?") {
        e.preventDefault();
        setHelp((h) => !h);
        return;
      }
      // Keys below are for the page, not over an open panel.
      if (document.querySelector("[role='dialog'][aria-modal='true']")) return;
      if (key === "g" && !e.shiftKey) {
        e.preventDefault();
        setWaitingG(true);
        g.current = setTimeout(clearG, G_WAIT_MS);
        return;
      }
      if (key === "[" || key === "]") {
        const tabs = [...(document.querySelector("main [role='tablist']")?.querySelectorAll<HTMLElement>("[role='tab']") ?? [])];
        const to = stepTab(tabs.length, tabs.findIndex((t) => t.getAttribute("aria-selected") === "true"), key === "]" ? 1 : -1);
        if (to >= 0) {
          e.preventDefault();
          tabs[to]!.click();
          tabs[to]!.focus();
        }
        return;
      }
      const at = document.activeElement as HTMLElement | null;
      const row = at?.closest<HTMLElement>("main tbody > tr");
      if (key === "c" && !e.shiftKey) {
        const t = (row?.closest("table") ?? at?.closest("main table") ?? pointerTable.current) as HTMLTableElement | null;
        if (t) {
          e.preventDefault();
          void copyTable(t);
        }
        return;
      }
      if (key === "j" || key === "k" || ((key === "ArrowDown" || key === "ArrowUp") && row && row === at)) {
        const rows = pageRows();
        if (!rows.length) return;
        const i = row ? rows.indexOf(row) : -1;
        const down = key === "j" || key === "ArrowDown";
        let to: HTMLElement | undefined;
        if (i < 0) {
          // From anywhere on the page: the first row in view.
          const view = document.getElementById("main")!.getBoundingClientRect();
          to = rows.find((r) => r.getBoundingClientRect().bottom > view.top + 40) ?? rows[0];
        } else to = rows[Math.max(0, Math.min(rows.length - 1, i + (down ? 1 : -1)))];
        if (to) {
          e.preventDefault();
          if (!to.hasAttribute("tabindex")) to.tabIndex = -1;
          to.focus();
          to.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      if (key === "Enter" && row && row === at) {
        const open = row.querySelector<HTMLElement>("[data-row-open], a[href], button:not([data-proof-key])");
        if (open) {
          e.preventDefault();
          open.click();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerover", over, { passive: true });
    return () => {
      clearG();
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerover", over);
    };
  }, [router]);

  const tab = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
  const jumps = Object.entries(JUMPS).map(([k, href]) => [k.toUpperCase(), TERMINAL_COMMANDS.find((c) => c.href === href)?.label ?? href] as const);
  return (
    <>
      {waitingG && (
        <div role="status" className="pointer-events-none fixed bottom-4 left-1/2 z-[360] -translate-x-1/2 rounded-md border border-accent bg-surface-2 px-3 py-1.5 font-mono text-xs text-fg shadow-lg">
          <span className="font-bold text-accent">G</span> … a letter for a page (? lists them)
        </div>
      )}
      <Drawer open={help} onClose={() => setHelp(false)} title="Keys" subtitle="Every key, for where you are. Help lists them all." width="30rem">
        <div className="flex flex-col gap-5 text-[13px]">
          {keySections(pathname, tab).map((s) => (
            <section key={s.title}>
              <h3 className="mb-1 text-2xs font-semibold uppercase tracking-[0.12em] text-faint">{s.title}</h3>
              <dl className="divide-y divide-line">
                {s.keys.map(([k, what]) => (
                  <div key={k} className="flex items-baseline gap-4 py-1.5">
                    <dt className="w-32 shrink-0">
                      <kbd className="font-mono text-xs text-accent">{k}</kbd>
                    </dt>
                    <dd className="text-fg-2">{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <section>
            <h3 className="mb-1 text-2xs font-semibold uppercase tracking-[0.12em] text-faint">G then</h3>
            <dl className="grid grid-cols-2 gap-x-4">
              {jumps.map(([k, label]) => (
                <div key={k} className="flex items-baseline gap-3 border-b border-line py-1">
                  <dt>
                    <kbd className="font-mono text-xs text-accent">{k}</kbd>
                  </dt>
                  <dd className="truncate text-fg-2">{label}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </Drawer>
    </>
  );
}
