"use client";

import { clearCachedResponses } from "@/components/ledger/useApi";
import { commandForPath, NAV_GROUPS, TERMINAL_COMMANDS, type TerminalCommand } from "@/components/shell/terminalCommands";
import { isUnlocked, LockScreen, setUnlocked } from "@/components/shell/LockScreen";
import { TerminalCommandBar } from "@/components/shell/TerminalCommandBar";
import { applyTheme, isAppTheme, THEMES, type AppTheme } from "@/lib/preferences";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

const NAV_COLLAPSED_KEY = "pf-nav-collapsed";
const THEME_LABEL: Record<AppTheme, string> = { light: "Light", dark: "Dark", bloomberg: "Terminal" };

/** Pages call this after changing the ledger so the sidebar badge refreshes (and no page draws from answers given before the change). */
export function notifyLedgerChanged() {
  clearCachedResponses();
  window.dispatchEvent(new Event("pf:ledger-changed"));
}

type Attention = { needsReview: number; integrityFailing: number; integrityMissing: number };

function useAttention(pathname: string): Attention | null {
  const [a, setA] = useState<Attention | null>(null);
  const load = useCallback(() => {
    const headers = new Headers();
    try {
      const s = sessionStorage.getItem("pf-api-secret");
      if (s) headers.set("x-api-secret", s);
    } catch {
      /* storage unavailable */
    }
    fetch("/api/ledger/attention", { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Attention | null) => j && setA(j))
      .catch(() => {});
  }, []);
  useEffect(load, [load, pathname]);
  useEffect(() => {
    window.addEventListener("pf:ledger-changed", load);
    return () => window.removeEventListener("pf:ledger-changed", load);
  }, [load]);
  return a;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<AppTheme>("bloomberg");
  const [shuttingDown, setShuttingDown] = useState(false);
  /** null until this tab's unlock flag has been read, so the app never flashes before the lock screen. */
  const [locked, setLocked] = useState<boolean | null>(null);
  /** Set on the demo instance (made-up data, no lock screen): where "Exit demo" leads. */
  const [demoExit, setDemoExit] = useState<string | null>(null);
  const attention = useAttention(pathname);
  const page = commandForPath(pathname);

  useEffect(() => {
    const unlocked = isUnlocked();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount: the unlock flag lives in sessionStorage, which the server render can't see
    if (unlocked) setLocked(false);
    // The demo instance has no lock screen; the real app shows it unless this tab is unlocked.
    fetch("/api/app-password")
      .then((r) => r.json())
      .then((j: { demo?: boolean; exitUrl?: string }) => {
        if (j.demo) {
          setDemoExit(j.exitUrl ?? "/");
          setLocked(false);
        } else if (!unlocked) setLocked(true);
      })
      .catch(() => !unlocked && setLocked(true));
    try {
      setCollapsed(localStorage.getItem(NAV_COLLAPSED_KEY) === "1");
    } catch {
      /* storage unavailable */
    }
    const t = document.documentElement.getAttribute("data-theme");
    if (isAppTheme(t)) setTheme(t);
  }, []);
  // Moving to another page closes the mobile menu (adjusted during render, not in an effect).
  const [seenPath, setSeenPath] = useState(pathname);
  if (pathname !== seenPath) {
    setSeenPath(pathname);
    setMobileOpen(false);
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMobileOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  };

  const cycleTheme = () => {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
    setTheme(next);
    applyTheme(next);
  };

  const handleShutdown = useCallback(async () => {
    if (!window.confirm("Shut down Raponiberg? It backs up first. Open Raponiberg on the Desktop to start it again; it picks up any updates when it starts.")) return;
    try {
      const res = await fetch("/api/system/shutdown", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        window.alert(body?.error ? `Shutdown failed: ${body.error}` : "Shutdown failed.");
        return;
      }
    } catch {
      // The connection can drop as the process exits — treat that as success.
    }
    setShuttingDown(true);
  }, []);

  if (shuttingDown) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-2 bg-canvas font-mono text-[13px]">
        <span className="font-semibold text-pos">SERVER STOPPED</span>
        <span className="text-muted">A last backup runs as it stops. Open Raponiberg on the Desktop to start it again (it updates on start).</span>
      </div>
    );
  }

  if (locked === null) return <div className="h-dvh bg-canvas" />;
  if (locked) {
    return (
      <>
        <LockScreen onUnlock={() => setLocked(false)} />
        {/* Same spot as the top bar's power button, so the app can be turned off without unlocking. */}
        <button
          type="button"
          onClick={() => void handleShutdown()}
          className="fixed right-3 top-2 flex h-8 w-8 items-center justify-center rounded-md text-muted outline-none hover:bg-neg-soft hover:text-neg focus-visible:ring-2 focus-visible:ring-focus"
          title="Shut down the server"
          aria-label="Shut down the server"
        >
          <PowerIcon />
        </button>
      </>
    );
  }

  const lock = () => {
    setUnlocked(false);
    setLocked(true);
  };

  const badges: Record<string, number | undefined> = {
    "/review": attention?.needsReview,
    "/statements": attention ? attention.integrityFailing + attention.integrityMissing : undefined,
  };

  return (
    <div className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-canvas text-[13px] text-fg">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[300] focus:rounded focus:bg-accent focus:px-3 focus:py-1.5 focus:text-accent-fg">
        Skip to content
      </a>
      {/* Top bar */}
      <header className="relative z-50 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 sm:gap-3 sm:px-3">
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus lg:hidden"
          aria-label="Open menu"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
        >
          <MenuIcon />
        </button>
        <button
          type="button"
          className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus lg:flex"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleCollapsed}
        >
          <MenuIcon />
        </button>
        <Link href="/" className="flex shrink-0 items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-accent font-mono text-[11px] font-black text-accent-fg">R</span>
          <span className="hidden font-mono text-[12px] font-bold tracking-[0.14em] text-fg sm:inline">RAPONIBERG</span>
        </Link>
        {demoExit && (
          <span className="shrink-0 rounded bg-warn-soft px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-[0.12em] text-warn" title="Made-up household: none of this is real data">
            DEMO
          </span>
        )}
        <div className="mx-auto w-full min-w-0 max-w-xl flex-1">
          <TerminalCommandBar onShutdown={handleShutdown} />
        </div>
        <button
          type="button"
          onClick={cycleTheme}
          className="hidden h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus sm:flex"
          title="Switch theme"
        >
          <ThemeIcon />
          <span>{THEME_LABEL[theme]}</span>
        </button>
        {demoExit ? (
          <a
            href={demoExit}
            className="flex h-8 shrink-0 items-center rounded-md px-2 text-xs text-muted outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
            title="Leave the demo (back to the lock screen)"
          >
            Exit demo
          </a>
        ) : (
          <>
            <button
              type="button"
              onClick={lock}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
              title="Lock (asks for the app password again)"
              aria-label="Lock the app"
            >
              <LockIcon />
            </button>
            <button
              type="button"
              onClick={() => void handleShutdown()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-neg-soft hover:text-neg focus-visible:ring-2 focus-visible:ring-focus"
              title="Shut down the server (OFF)"
              aria-label="Shut down the server"
            >
              <PowerIcon />
            </button>
          </>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Desktop sidebar */}
        <aside className={`hidden shrink-0 border-r border-line bg-surface lg:flex lg:flex-col ${collapsed ? "w-[60px]" : "w-56"}`}>
          <Nav pathname={pathname} badges={badges} compact={collapsed} />
        </aside>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-[90] lg:hidden">
            <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
            <aside className="relative flex h-full w-64 flex-col border-r border-line bg-surface shadow-2xl">
              <Nav pathname={pathname} badges={badges} compact={false} />
            </aside>
          </div>
        )}

        <main id="main" className="app-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          {page && pathname !== "/" && <PageHeader page={page} />}
          {children}
        </main>
      </div>
    </div>
  );
}

function PageHeader({ page }: { page: TerminalCommand }) {
  return (
    <div className="mx-auto w-full max-w-[96rem] px-4 pb-1 pt-5 sm:px-6">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{page.label}</h1>
        <span className="font-mono text-[11px] font-bold text-accent" title={`Type ${page.mnemonic} in the command bar to come back here`}>
          {page.mnemonic}
        </span>
      </div>
      {page.description && <p className="mt-0.5 max-w-3xl text-[13px] text-muted">{page.description}</p>}
    </div>
  );
}

function Nav({ pathname, badges, compact }: { pathname: string; badges: Record<string, number | undefined>; compact: boolean }) {
  const active = commandForPath(pathname);
  return (
    <nav aria-label="Main" className="app-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3">
      {NAV_GROUPS.map((g) => {
        const items = TERMINAL_COMMANDS.filter((c) => c.group === g && !c.hidden);
        if (!items.length) return null;
        return (
          <div key={g} className="mb-3">
            {!compact && <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">{g}</div>}
            {compact && <div className="mx-2 mb-1.5 border-t border-line" />}
            <ul className="flex flex-col gap-px">
              {items.map((c) => {
                const on = active?.href === c.href;
                const badge = badges[c.href];
                return (
                  <li key={c.href}>
                    <Link
                      href={c.href}
                      title={compact ? `${c.label} (${c.mnemonic})` : c.description}
                      aria-current={on ? "page" : undefined}
                      className={`group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus ${
                        on ? "bg-accent-soft text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg"
                      } ${compact ? "justify-center" : ""}`}
                    >
                      {on && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-accent" />}
                      <span className={`shrink-0 font-mono text-[10px] font-bold ${compact ? "w-auto" : "w-9"} ${on ? "text-accent" : "text-faint group-hover:text-accent"}`}>
                        {c.mnemonic}
                      </span>
                      {!compact && <span className="min-w-0 flex-1 truncate text-[13px]">{c.label}</span>}
                      {badge ? (
                        <span
                          className={`num rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-accent-fg ${compact ? "absolute -right-0.5 -top-0.5" : ""}`}
                          aria-label={`${badge} waiting`}
                        >
                          {badge > 999 ? "999+" : badge}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <div className={`mt-auto border-t border-line pt-2 ${compact ? "text-center" : "px-2"}`}>
        <Link href="/help" className="text-[11px] text-muted outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus" title="All functions and shortcuts">
          {compact ? "?" : "Help · shortcuts"}
        </Link>
      </div>
    </nav>
  );
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ThemeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 1.75v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.6 3.9a5.25 5.25 0 1 0 6.8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
