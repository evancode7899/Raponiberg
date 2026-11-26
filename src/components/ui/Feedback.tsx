"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { btn } from "./kit";

type Ask = { title: string; body?: ReactNode; confirm?: string; danger?: boolean };
type Toast = { id: number; text: string; tone: "good" | "bad" | "info"; undo?: () => void | Promise<void>; action?: { label: string; run: () => void } };
type ToastOptions = { tone?: Toast["tone"]; undo?: Toast["undo"]; action?: Toast["action"] };
type Host = { confirm: (ask: Ask) => Promise<boolean>; toast: (text: string, opts?: ToastOptions) => void };

const STAYS_MS = 6000;
/** The mounted host (AppShell), which draws what the functions below ask for. */
let host: Host | null = null;

/** Asks before something hard to take back; true when the owner says yes. */
export const ask = (q: Ask | string): Promise<boolean> => {
  const a = typeof q === "string" ? { title: q } : q;
  return host ? host.confirm(a) : Promise.resolve(window.confirm(a.title));
};
/** Asks before something that deletes or replaces: it starts on Cancel. */
export const askDanger = (title: string, confirm = "Delete", body?: ReactNode): Promise<boolean> => ask({ title, body, confirm, danger: true });
/** Says what just happened, with a way to take it back when there is one. */
export const notify = (text: string, opts?: ToastOptions): void => host?.toast(text, opts);

/** Draws the app's own confirmations and notices, in its own style and reachable by keyboard, in place of the browser's dialogs. */
export function FeedbackHost() {
  const [asking, setAsking] = useState<(Ask & { answer: (yes: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const confirm = useCallback((a: Ask) => new Promise<boolean>((resolve) => setAsking({ ...a, answer: resolve })), []);
  const drop = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback<Host["toast"]>(
    (text, opts = {}) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, text, tone: opts.tone ?? "good", undo: opts.undo, action: opts.action }]);
      setTimeout(() => drop(id), opts.undo || opts.action ? STAYS_MS * 2 : STAYS_MS);
    },
    [drop],
  );
  useEffect(() => {
    const mine: Host = { confirm, toast };
    host = mine;
    return () => {
      if (host === mine) host = null;
    };
  }, [confirm, toast]);

  const answer = (yes: boolean) => {
    asking?.answer(yes);
    setAsking(null);
  };

  return (
    <>
      {asking && <Dialog ask={asking} onAnswer={answer} />}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[350] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`pointer-events-auto flex items-start gap-3 rounded-md border bg-surface-2 px-3 py-2 text-[13px] text-fg shadow-lg ${t.tone === "bad" ? "border-neg" : t.tone === "good" ? "border-pos/60" : "border-line-strong"}`}>
            <span className="min-w-0 flex-1 break-words">{t.text}</span>
            {t.undo && (
              <button
                type="button"
                className={btn.link}
                onClick={() => {
                  drop(t.id);
                  void Promise.resolve(t.undo!()).catch((e: unknown) => toast(e instanceof Error ? e.message : "Couldn't undo", { tone: "bad" }));
                }}
              >
                Undo
              </button>
            )}
            {t.action && (
              <button
                type="button"
                className={btn.link}
                onClick={() => {
                  drop(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="text-muted hover:text-fg" aria-label="Dismiss" onClick={() => drop(t.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function Dialog({ ask, onAnswer }: { ask: Ask; onAnswer: (yes: boolean) => void }) {
  const id = useId();
  const yes = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  const answer = useRef(onAnswer);
  useEffect(() => {
    answer.current = onAnswer;
  });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Something destructive starts on the safe answer.
    (ask.danger ? no : yes).current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        answer.current(false);
      } else if (e.key === "Tab") {
        // Two stops, and the page behind is none of them.
        e.preventDefault();
        (document.activeElement === yes.current ? no : yes).current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [ask.danger]);
  return (
    <div className="fixed inset-0 z-[340] flex items-center justify-center p-4">
      <button type="button" aria-label="Cancel" tabIndex={-1} className="absolute inset-0 cursor-default bg-black/55" onClick={() => onAnswer(false)} />
      <div role="alertdialog" aria-modal="true" aria-labelledby={id} className="relative w-full max-w-md rounded-lg border border-line-strong bg-surface p-5 shadow-2xl">
        <h2 id={id} className="text-sm font-semibold leading-snug text-fg">
          {ask.title}
        </h2>
        {ask.body && <div className="mt-2 text-xs leading-relaxed text-fg-2">{ask.body}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button ref={no} type="button" className={btn.secondary} onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button ref={yes} type="button" className={ask.danger ? btn.danger : btn.primary} onClick={() => onAnswer(true)}>
            {ask.confirm ?? "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
