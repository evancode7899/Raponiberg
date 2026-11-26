"use client";

import { suggest } from "@/components/shell/commandSearch";
import { PANEL_ABOUT } from "@/components/ui/panelAbout";
import { linkOf, rowsMatching, rowsShown, sameLink, type DeskLink } from "@/lib/deskLinks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/** A row's link, read off the page its open link goes to (lib/deskLinks.ts). */
const rowLink = (row: Element): DeskLink | null => linkOf(row.querySelector<HTMLAnchorElement>("[data-desk-open]")?.getAttribute("href"));

/**
 * A desk of panels: dense tiles on a shared grid, moved between with the keyboard. Each panel
 * is one stop; its rows (data-desk-row) are reached with the arrows, and Enter opens a row.
 * Space on a row about a category or a month links the panels: every other panel narrows to
 * that category or month where it has rows about one (Esc lets go). ":" opens the focused
 * panel's own command line.
 */
export function Desk({ children, onKey }: { children: ReactNode; onKey?: (key: string) => boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<DeskLink | null>(null);

  // Narrow every panel to the picked link, again whenever a panel draws new rows.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const apply = () => {
      for (const panel of el.querySelectorAll<HTMLElement>("[data-panel]")) {
        const rows = [...panel.querySelectorAll<HTMLElement>("[data-desk-row]")];
        const links = rows.map(rowLink);
        const own = links.some((l) => sameLink(l, pick));
        const shown = own ? rows.map(() => true) : rowsShown(links, pick);
        rows.forEach((r, i) => {
          r.toggleAttribute("data-link-hidden", !shown[i]);
          r.toggleAttribute("data-link-picked", sameLink(links[i]!, pick));
        });
      }
    };
    apply();
    let queued = 0;
    const watch = new MutationObserver(() => {
      if (!queued) queued = requestAnimationFrame(() => ((queued = 0), apply()));
    });
    watch.observe(el, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      cancelAnimationFrame(queued);
    };
  }, [pick]);

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[role="radiogroup"]')) return;
    const panels = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-panel]")];
    const at = panels.findIndex((p) => p.contains(t));
    const rows = at < 0 ? [] : [...panels[at]!.querySelectorAll<HTMLElement>("[data-desk-row]")].filter((r) => r.getClientRects().length > 0);
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
    else if (key === " " && t.matches("[data-desk-row]") && rowLink(t)) {
      e.preventDefault();
      const l = rowLink(t);
      setPick((p) => (sameLink(p, l) ? null : l));
    } else if (key === "Escape" && pick) {
      e.preventDefault();
      setPick(null);
    } else if (key === "i" && at >= 0) {
      e.preventDefault();
      panels[at]!.querySelector<HTMLButtonElement>("[data-panel-about-open]")?.click();
    } else if (key === ":" && at >= 0) {
      e.preventDefault();
      panels[at]!.querySelector<HTMLButtonElement>("[data-panel-line-open]")?.click();
    } else if (onKey?.(key)) e.preventDefault();
  };
  return (
    <div
      ref={root}
      onKeyDown={keys}
      data-desk-pick={pick ? `${pick.kind}:${pick.value}` : undefined}
      className="relative grid min-w-0 grid-cols-1 gap-px border-y border-line bg-line md:grid-cols-2 xl:min-h-[38rem] xl:flex-1 xl:grid-cols-12 xl:grid-rows-[minmax(0,1.15fr)_minmax(0,1.1fr)_minmax(0,0.75fr)]"
    >
      {children}
      {pick && (
        <div role="status" className="absolute bottom-1 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 border border-accent bg-surface-2 px-2 py-0.5 text-2xs text-fg shadow-lg">
          <span className="font-bold text-accent">LINK</span>
          {pick.kind === "category" ? pick.value : `month ${pick.value}`}
          <button type="button" className="text-muted hover:text-fg" onClick={() => setPick(null)} aria-label="Let go of the link">
            Esc ✕
          </button>
        </div>
      )}
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
  const self = useRef<HTMLElement>(null);
  return (
    <section
      ref={self}
      data-panel=""
      tabIndex={0}
      aria-label={typeof title === "string" ? title : code}
      className={`group/panel relative flex min-h-[13rem] min-w-0 flex-col bg-surface outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus xl:min-h-0 ${className}`}
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
        <PanelLine panel={self} code={code} />
        {note && <span className="ml-auto truncate whitespace-nowrap text-[11px] text-faint">{note}</span>}
        <PanelAboutButton panel={self} code={code} title={typeof title === "string" ? title : code} />
      </header>
      <div className={`app-scroll relative min-h-0 flex-1 overflow-auto ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/**
 * What the panel is (panelAbout.ts): its "i" button, or I on the panel, lays a short note over
 * the panel's body. Nothing on the page moves; Esc, I again or a click elsewhere closes it.
 */
function PanelAboutButton({ panel, code, title }: { panel: React.RefObject<HTMLElement | null>; code: string; title: string }) {
  const about = PANEL_ABOUT[code];
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.focus();
    const away = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open, panel]);
  if (!about) return null;
  const close = () => {
    setOpen(false);
    panel.current?.focus();
  };
  return (
    <>
      <button
        type="button"
        data-panel-about-open=""
        tabIndex={-1}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        title={`What is this? (I)`}
        aria-label={`What is ${title}?`}
        className={`shrink-0 font-mono text-[11px] hover:text-accent ${note(open)}`}
      >
        i
      </button>
      {open && (
        <div
          ref={box}
          role="dialog"
          aria-label={`About ${title}`}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key.toLowerCase() === "i") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
          className="absolute inset-x-1 top-[1.6rem] z-30 border border-accent bg-surface-2 p-2 text-[12px] leading-snug text-fg-2 shadow-lg outline-none"
        >
          <p className="text-fg">{about.what}</p>
          <p className="mt-1"><span className="text-muted">From </span>{about.from}</p>
          {about.use && <p className="mt-1">{about.use}</p>}
        </div>
      )}
    </>
  );
}

const note = (open: boolean) => (open ? "text-accent opacity-100" : "text-faint opacity-0 group-hover/panel:opacity-100 group-focus-within/panel:opacity-100");

/**
 * A panel's own command line (":" on the panel, or its > button): words narrow the panel to
 * the rows that hold them, Enter opens the first one left; anything no row holds runs as a
 * command (a code such as TAX, or words to find), like the command bar at the top.
 */
function PanelLine({ panel, code }: { panel: React.RefObject<HTMLElement | null>; code: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const rows = [...(panel.current?.querySelectorAll<HTMLElement>("[data-desk-row]") ?? [])];
    const keep = rowsMatching(rows.map((r) => r.textContent ?? ""), open ? line : "");
    rows.forEach((r, i) => r.toggleAttribute("data-line-hidden", !keep[i]));
  }, [line, open, panel]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    setLine("");
    panel.current?.focus();
  };
  if (!open)
    return (
      <button type="button" data-panel-line-open="" tabIndex={-1} onClick={() => setOpen(true)} title={`${code}'s own command line (:)`} className="shrink-0 font-mono text-[11px] text-faint opacity-0 hover:text-accent group-hover/panel:opacity-100 group-focus-within/panel:opacity-100">
        &gt;_
      </button>
    );
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1 font-mono">
      <span className="text-accent" aria-hidden>
        &gt;
      </span>
      <input
        ref={input}
        value={line}
        onChange={(e) => setLine(e.target.value)}
        aria-label={`Narrow ${code} or run a command`}
        placeholder="words, or a code"
        className="min-w-0 flex-1 bg-transparent text-[11px] text-fg outline-none placeholder:text-faint"
        onBlur={() => !line && setOpen(false)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Enter") {
            e.preventDefault();
            const first = [...(panel.current?.querySelectorAll<HTMLElement>("[data-desk-row]:not([data-line-hidden])") ?? [])][0];
            if (first && line.trim()) return first.querySelector<HTMLElement>("[data-desk-open]")?.click();
            const s = suggest(line)[0];
            if (s && !s.action && !s.proof && s.href) router.push(s.href);
          }
        }}
      />
    </span>
  );
}

/** Classes of a panel's table: tight rows, a head that stays, figures on the right. */
export const grid = {
  table: "w-full border-collapse text-[12px] min-[1800px]:text-[13px]",
  th: "sticky top-0 z-[1] whitespace-nowrap border-b border-line bg-surface px-2 py-[3px] text-right text-[11px] font-medium text-muted first:text-left min-[1800px]:text-[12px]",
  td: "num whitespace-nowrap border-b border-line/60 px-2 py-[2.5px] text-right first:text-left min-[1800px]:py-[5px]",
  name: "w-full max-w-0 truncate border-b border-line/60 px-2 py-[2.5px] text-left min-[1800px]:py-[5px]",
  row: "outline-none hover:bg-surface-2 focus:bg-accent-soft focus:shadow-[inset_2px_0_0_var(--accent)] data-[link-picked]:bg-accent-soft",
};
