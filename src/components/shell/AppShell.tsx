"use client";

import { apiSecretHeaders, clearCachedResponses } from "@/components/ledger/useApi";
import { commandForPath, NAV_GROUPS, TERMINAL_COMMANDS, type TerminalCommand } from "@/components/shell/terminalCommands";
import { isUnlocked, LockScreen, setUnlocked } from "@/components/shell/LockScreen";
import { TerminalCommandBar } from "@/components/shell/TerminalCommandBar";
import { Tooltips } from "@/components/shell/Tooltips";
import { KeyMap } from "@/components/shell/KeyMap";
import { isSplitPane, SplitPane, useSplit } from "@/components/shell/SplitView";
import { Tour } from "@/components/shell/Tour";
import { DropAnywhere } from "@/components/shell/DropAnywhere";
import { ask, FeedbackHost, notify } from "@/components/ui/Feedback";
import { ProofProvider } from "@/components/ui/proof/ProofProvider";
import { amountsHidden, applyTheme, idleLockMinutes, isAppTheme, PREFERENCE_CHANGED_EVENT, setAmountsHidden, THEME_CHANGED_EVENT, THEMES, type AppTheme } from "@/lib/preferences";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const NAV_COLLAPSED_KEY = "pf-nav-collapsed";
const DEFAULT_PASSWORD_SAID = "pf-default-password-said";
const THEME_LABEL: Record<AppTheme, string> = { light: "Light", dark: "Dark", terminal: "Terminal" };

/** Pages call this after changing the ledger so the sidebar badge refreshes (and no page draws from answers given before the change). */
export function notifyLedgerChanged() {
  clearCachedResponses();
  window.dispatchEvent(new Event("pf:ledger-changed"));
}

type Attention = { needsReview: number; integrityFailing: number; integrityMissing: number };

function useAttention(pathname: string): Attention | null {
  const [a, setA] = useState<Attention | null>(null);
  const load = useCallback(() => {
    fetch("/api/ledger/attention", { headers: apiSecretHeaders() })
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

/** Locks the app after the minutes Settings › General asks for without a key, click or scroll; never when it asks for none. */
function useIdleLock(active: boolean, lock: () => void) {
  const run = useRef(lock);
  useEffect(() => {
    run.current = lock;
  });
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const arm = () => {
      clearTimeout(timer);
      const minutes = idleLockMinutes();
      if (minutes) timer = setTimeout(() => run.current(), minutes * 60_000);
    };
    const onUse = () => {
      // Pointer moves come in floods: once a second is enough to know it's in use.
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      arm();
    };
    arm();
    const events = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const e of events) window.addEventListener(e, onUse, { passive: true });
    window.addEventListener(PREFERENCE_CHANGED_EVENT, arm);
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, onUse);
      window.removeEventListener(PREFERENCE_CHANGED_EVENT, arm);
    };
  }, [active]);
}

/**
 * Back and Forward return to where the page was scrolled. The browser does that for the
 * window, but this app scrolls inside its frame (main), so it is kept here, by address. A page
 * still drawing is too short at first, so it is tried again for a moment.
 */
function useScrollMemory(ready: boolean) {
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = main.current;
    if (!ready || !el) return;
    const at = new Map<string, number>();
    const here = () => window.location.pathname + window.location.search;
    let key = here();
    let stop = 0;
    const onScroll = () => {
      // The address moves before the old page is gone: its last scroll belongs to the old one.
      if (here() === key) at.set(key, el.scrollTop);
      else key = here();
    };
    const onPop = () => {
      key = here();
      const want = at.get(key) ?? 0;
      const until = performance.now() + 700;
      const attempt = () => {
        el.scrollTop = want;
        if (Math.abs(el.scrollTop - want) > 2 && performance.now() < until) stop = requestAnimationFrame(attempt);
      };
      stop = requestAnimationFrame(attempt);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", onPop);
    return () => {
      cancelAnimationFrame(stop);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("popstate", onPop);
    };
  }, [ready]);
  return main;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<AppTheme>("terminal");
  const [shuttingDown, setShuttingDown] = useState(false);
  /** null until this tab's unlock flag has been read, so the app never flashes before the lock screen. */
  const [locked, setLocked] = useState<boolean | null>(null);
  /** Set on the demo instance (made-up data, no lock screen): where "Exit demo" leads. */
  const [demoExit, setDemoExit] = useState<string | null>(null);
  const attention = useAttention(pathname);
  const page = commandForPath(pathname);
  const main = useScrollMemory(locked === false && !shuttingDown);
  // A new page puts the keyboard at its start (the sidebar link or command line it came from is behind it), and a screen reader reads it.
  const seenPage = useRef<string | null>(null);
  useEffect(() => {
    const was = seenPage.current;
    seenPage.current = pathname;
    if (was == null || was === pathname) return;
    const el = main.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [pathname, main]);
  const [hidden, setHidden] = useState(false);
  /** The lock screen still takes the default password: said once a session, after unlocking (never on the lock screen itself). */
  const [defaultPassword, setDefaultPassword] = useState(false);
  /** This page is the right-hand side of a split (the app framed by itself): drawn without the top bar and sidebar. */
  const [pane, setPane] = useState(false);
  const [split, setSplit] = useSplit();
  const router = useRouter();
  useEffect(() => {
    if (locked !== false || !defaultPassword || pane) return;
    try {
      if (sessionStorage.getItem(DEFAULT_PASSWORD_SAID)) return;
      sessionStorage.setItem(DEFAULT_PASSWORD_SAID, "1");
    } catch {
      /* storage unavailable: say it anyway */
    }
    notify("The app password is still the default one. Anyone at this computer can open Raponiberg with it.", { tone: "info", action: { label: "Set your own", run: () => router.push("/settings?tab=general") } });
  }, [locked, defaultPassword, pane, router]);
  useEffect(() => {
    const read = () => setHidden(amountsHidden());
    read();
    window.addEventListener(PREFERENCE_CHANGED_EVENT, read);
    return () => window.removeEventListener(PREFERENCE_CHANGED_EVENT, read);
  }, []);
  // The demo has no lock screen to lock to.
  useIdleLock(locked === false && !demoExit && !shuttingDown && !pane, () => {
    setUnlocked(false);
    setLocked(true);
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount: whether the page is framed, and the unlock flag in sessionStorage, are the browser's to say
    setPane(isSplitPane());
    const unlocked = isUnlocked();
    if (unlocked) setLocked(false);
    // The demo instance has no lock screen; the real app shows it unless this tab is unlocked.
    fetch("/api/app-password")
      .then((r) => r.json())
      .then((j: { demo?: boolean; exitUrl?: string; isDefault?: boolean }) => {
        setDefaultPassword(j.isDefault === true);
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
  // Settings › General changes the theme too; keep the top bar's label in step.
  useEffect(() => {
    const onTheme = (e: Event) => setTheme((e as CustomEvent<AppTheme>).detail);
    window.addEventListener(THEME_CHANGED_EVENT, onTheme);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onTheme);
  }, []);
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

  const cycleTheme = () => applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!);

  const handleShutdown = useCallback(async () => {
    if (!(await ask({ title: "Shut down Raponiberg?", body: "It backs up first. Open Raponiberg on the Desktop to start it again; it picks up any updates when it starts.", confirm: "Shut down" }))) return;
    try {
      const res = await fetch("/api/system/shutdown", { method: "POST", headers: apiSecretHeaders() });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        notify(body?.error ? `Shutdown failed: ${body.error}` : "Shutdown failed.", { tone: "bad" });
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
  if (pane) {
    // The frame shares this tab's unlock flag; a locked app shows nothing beside it.
    if (locked) return <div className="flex h-dvh items-center justify-center bg-canvas text-xs text-muted">Locked</div>;
    return (
      <div className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-canvas text-[13px] text-fg">
        <main id="main" ref={main} tabIndex={-1} className="app-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none">
          {page && pathname !== "/" && <PageHeader page={page} />}
          <ProofProvider>{children}</ProofProvider>
        </main>
        <FeedbackHost />
        <Tooltips />
        <KeyMap />
      </div>
    );
  }
  if (locked) {
    return (
      <>
        <LockScreen onUnlock={() => setLocked(false)} />
        <FeedbackHost />
        <Tooltips />
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
    // Statements holds the review queue too (its Categorize tab), so its badge counts both.
    "/statements": attention ? attention.needsReview + attention.integrityFailing + attention.integrityMissing : undefined,
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
          aria-pressed={hidden}
          onClick={() => setAmountsHidden(!hidden)}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus ${hidden ? "text-accent" : "text-muted"}`}
          title={hidden ? "Show amounts" : "Hide amounts (blurs every figure on screen)"}
          aria-label={hidden ? "Show amounts" : "Hide amounts"}
        >
          <EyeIcon off={hidden} />
        </button>
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

        <main id="main" ref={main} tabIndex={-1} className="app-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none">
          {page && pathname !== "/" && <PageHeader page={page} />}
          <ProofProvider>{children}</ProofProvider>
        </main>
        {split && (
          <SplitPane
            href={split}
            onClose={() => setSplit(null)}
            onOpenHere={() => {
              setSplit(null);
              router.push(split);
            }}
          />
        )}
      </div>
      <FeedbackHost />
      <Tooltips />
      <KeyMap />
      <Tour auto={!!demoExit} />
      <DropAnywhere />
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

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M1.5 8s2.4-4.25 6.5-4.25S14.5 8 14.5 8 12.1 12.25 8 12.25 1.5 8 1.5 8z" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      {off && <path d="M2.5 13.5l11-11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
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
