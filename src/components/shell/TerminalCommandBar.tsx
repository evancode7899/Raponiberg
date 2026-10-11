"use client";

import { filterCommands, getCommandByMnemonic, type TerminalCommand } from "@/components/shell/terminalCommands";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * The command line: type a mnemonic (NW, CF, TXN…) or part of a name and press Enter.
 * Ctrl+K (⌘K) or "/" focuses it from anywhere; Esc leaves it.
 */
export function TerminalCommandBar({ onShutdown }: { onShutdown?: () => void }) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [line, setLine] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const matches = filterCommands(line);
  const showList = open && matches.length > 0;

  const go = useCallback(
    (cmd: TerminalCommand) => {
      setLine("");
      setOpen(false);
      inputRef.current?.blur();
      if (cmd.action === "shutdown") {
        onShutdown?.();
        return;
      }
      router.push(cmd.href);
    },
    [router, onShutdown],
  );

  const submit = useCallback(() => {
    const exact = getCommandByMnemonic(line);
    if (exact) return go(exact);
    const pick = matches[highlight] ?? matches[0];
    if (pick && line.trim()) go(pick);
  }, [line, matches, highlight, go]);

  useEffect(() => setHighlight(0), [line]);

  // Global shortcut: Ctrl/⌘+K anywhere, or "/" when not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!showList) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-command-root]")) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showList]);

  return (
    <div data-command-root className="relative w-full">
      <div className="flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-2.5 focus-within:border-accent focus-within:bg-surface">
        <span className="select-none font-mono text-xs font-bold text-accent" aria-hidden>
          &gt;
        </span>
        <input
          ref={inputRef}
          type="text"
          value={line}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Go to a function"
          aria-autocomplete="list"
          aria-controls={showList ? listId : undefined}
          aria-expanded={showList}
          role="combobox"
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-fg outline-none placeholder:text-faint"
          placeholder="Go to… type a function (NW, CF, TXN) or a name"
          onChange={(e) => {
            setLine(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setHighlight((h) => Math.min(matches.length - 1, h + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === "Escape") {
              setOpen(false);
              setLine("");
              inputRef.current?.blur();
            }
          }}
        />
        <kbd className="hidden shrink-0 rounded border border-line-strong px-1 font-mono text-[10px] text-faint sm:inline">Ctrl K</kbd>
      </div>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="app-scroll absolute left-0 right-0 top-[calc(100%+4px)] z-[200] max-h-[min(70vh,26rem)] overflow-auto rounded-md border border-line-strong bg-surface py-1 shadow-xl"
        >
          {matches.map((c, i) => (
            <li key={c.mnemonic} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-[13px] ${i === highlight ? "bg-surface-3" : "hover:bg-surface-2"}`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  go(c);
                }}
              >
                <span className="w-11 shrink-0 font-mono text-xs font-bold text-accent">{c.mnemonic}</span>
                <span className="shrink-0 text-fg">{c.label}</span>
                <span className="truncate text-xs text-muted">{c.description ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
