"use client";

import Link from "next/link";
import type { KeyboardEvent, ReactNode } from "react";

/**
 * A desk of panels: dense tiles on a shared grid, moved between with the keyboard. Each panel
 * is one stop; its rows (data-desk-row) are reached with the arrows, and Enter opens a row.
 */
export function Desk({ children, onKey }: { children: ReactNode; onKey?: (key: string) => boolean }) {
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[role="radiogroup"]')) return;
    const panels = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-panel]")];
    const at = panels.findIndex((p) => p.contains(t));
    const rows = at < 0 ? [] : [...panels[at]!.querySelectorAll<HTMLElement>("[data-desk-row]")];
    const row = rows.findIndex((r) => r.contains(t));
    const focus = (el: HTMLElement | undefined) => {
      if (!el) return;
      e.preventDefault();
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    };
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === "ArrowDown" || key === "j") focus(rows[Math.min(rows.length - 1, row + 1)]);
    else if (key === "ArrowUp" || key === "k") focus(row <= 0 ? panels[at] : rows[row - 1]);
    else if (key === "ArrowRight" || key === "l") focus(panels[(at + 1) % panels.length]);
    else if (key === "ArrowLeft" || key === "h") focus(panels[(at + panels.length - 1) % panels.length]);
    else if (key === "Enter" && t.matches("[data-desk-row]")) t.querySelector<HTMLElement>("[data-desk-open]")?.click();
    else if (key === "Enter" && t.matches("[data-panel]")) t.querySelector<HTMLElement>("[data-panel-open]")?.click();
    else if (onKey?.(key)) e.preventDefault();
  };
  return (
    <div
      onKeyDown={keys}
      className="grid min-w-0 grid-cols-1 gap-px border-y border-line bg-line md:grid-cols-2 xl:min-h-[38rem] xl:flex-1 xl:grid-cols-12 xl:grid-rows-[minmax(0,1.15fr)_minmax(0,1.1fr)_minmax(0,0.75fr)]"
    >
      {children}
    </div>
  );
}

export function Panel({
  code,
  title,
  href,
  note,
  controls,
  className = "",
  bodyClassName = "",
  children,
}: {
  code: string;
  title: ReactNode;
  href?: string;
  note?: ReactNode;
  controls?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const heading = (
    <>
      <span className="font-bold text-accent">{code}</span>
      <h2 className="truncate font-semibold text-fg">{title}</h2>
    </>
  );
  return (
    <section
      data-panel=""
      tabIndex={0}
      aria-label={typeof title === "string" ? title : code}
      className={`group/panel flex min-h-[13rem] min-w-0 flex-col bg-surface outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus xl:min-h-0 ${className}`}
    >
      <header className="flex min-h-[1.45rem] shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-2 text-[11.5px] leading-none group-focus-within/panel:bg-accent-soft">
        {href ? (
          <Link data-panel-open="" href={href} className="flex min-w-0 items-center gap-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus">
            {heading}
          </Link>
        ) : (
          heading
        )}
        {controls}
        {note && <span className="ml-auto truncate whitespace-nowrap text-[11px] text-faint">{note}</span>}
      </header>
      <div className={`app-scroll relative min-h-0 flex-1 overflow-auto ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** Classes of a panel's table: tight rows, a head that stays, figures on the right. */
export const grid = {
  table: "w-full border-collapse text-[12px]",
  th: "sticky top-0 z-[1] whitespace-nowrap border-b border-line bg-surface px-2 py-[3px] text-right text-[11px] font-medium text-muted first:text-left",
  td: "num whitespace-nowrap border-b border-line/60 px-2 py-[2.5px] text-right first:text-left",
  name: "w-full max-w-0 truncate border-b border-line/60 px-2 py-[2.5px] text-left",
  row: "outline-none hover:bg-surface-2 focus:bg-accent-soft focus:shadow-[inset_2px_0_0_var(--accent)]",
};
