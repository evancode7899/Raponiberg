import { NAV_GROUPS, TERMINAL_COMMANDS } from "@/components/shell/terminalCommands";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Help",
  description: "Every function, its mnemonic, and keyboard shortcuts",
};

const SHORTCUTS: [string, string][] = [
  ["Ctrl K  or  /", "Jump to the command bar from anywhere"],
  ["Enter", "Go to the highlighted function"],
  ["↑ ↓", "Move through command-bar matches"],
  ["Esc", "Close the command list, a side panel or the menu"],
];

export default function HelpPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pb-12 pt-4 sm:px-6">
      <p className="text-[13px] text-fg-2">
        Type a <span className="font-mono font-bold text-accent">MNEMONIC</span> in the command bar at the top and press Enter, or type part of a name and pick
        from the list.
      </p>

      {NAV_GROUPS.map((g) => {
        const rows = TERMINAL_COMMANDS.filter((c) => c.group === g && c.mnemonic !== "HELP");
        if (!rows.length) return null;
        return (
          <section key={g}>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{g}</h2>
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
              {rows.map((c) => (
                <li key={c.mnemonic}>
                  {c.action ? (
                    <div className="flex items-baseline gap-4 px-4 py-2.5">
                      <span className="w-12 shrink-0 font-mono text-xs font-bold text-accent">{c.mnemonic}</span>
                      <span className="text-[13px] font-medium text-fg">{c.label}</span>
                      <span className="text-xs text-muted">command bar or the power button</span>
                    </div>
                  ) : (
                    <Link href={c.href} className="flex items-baseline gap-4 px-4 py-2.5 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
                      <span className="w-12 shrink-0 font-mono text-xs font-bold text-accent">{c.mnemonic}</span>
                      <span className="shrink-0 text-[13px] font-medium text-fg">{c.label}</span>
                      <span className="min-w-0 truncate text-xs text-muted">{c.description ?? c.href}</span>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Keyboard</h2>
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {SHORTCUTS.map(([k, what]) => (
            <li key={k} className="flex items-baseline gap-4 px-4 py-2.5 text-[13px]">
              <kbd className="w-28 shrink-0 font-mono text-xs text-accent">{k}</kbd>
              <span className="text-fg-2">{what}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-[11px] text-faint">
        The terminal look is inspired by Bloomberg Professional layout patterns (command line, mnemonics, monospace grid). Not affiliated with Bloomberg L.P.
      </p>
    </div>
  );
}
