"use client";

import { SecretBox } from "@/components/ui/kit";
import { useState } from "react";

const UNLOCKED_KEY = "pf-unlocked";

/** Whether this tab has already passed the lock screen (it asks again in a new browser session). */
export function isUnlocked(): boolean {
  try {
    return sessionStorage.getItem(UNLOCKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setUnlocked(on: boolean) {
  try {
    if (on) sessionStorage.setItem(UNLOCKED_KEY, "1");
    else sessionStorage.removeItem(UNLOCKED_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * The password screen in front of the app (lib/appPassword.ts). A casual-use deterrent, not
 * security: nothing is encrypted and a wrong guess never locks anyone out.
 */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  /** "demo" was typed: the demo instance is starting (or failed to). */
  const [demo, setDemo] = useState<"starting" | string | null>(null);

  const submit = async () => {
    if (busy || !password) return;
    setBusy(true);
    setWrong(false);
    if (password.trim().toLowerCase() === "demo") setDemo("starting");
    try {
      const res = await fetch("/api/app-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; demo?: string; error?: string } | null;
      if (body?.ok) {
        setUnlocked(true);
        onUnlock();
        return;
      }
      if (body?.demo) {
        window.location.assign(body.demo);
        return;
      }
      if (body?.error) {
        setDemo(body.error);
        setPassword("");
        return;
      }
      setDemo(null);
      setWrong(true);
      setPassword("");
    } catch {
      setDemo(null);
      setWrong(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-canvas px-4 text-[13px] text-fg">
      <div className="flex w-full max-w-xs flex-col gap-4 rounded-lg border border-line bg-surface p-6 shadow-[var(--shadow)]">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-accent font-mono text-[12px] font-black text-accent-fg">R</span>
          <span className="font-mono text-[13px] font-bold tracking-[0.14em]">RAPONIBERG</span>
        </div>
        <div className="flex flex-col gap-1.5 text-xs">
          <span id="lock-label" className="font-medium text-fg-2">
            Password
          </span>
          <SecretBox
            autoFocus
            labelledBy="lock-label"
            value={password}
            onChange={(v) => {
              setPassword(v);
              setWrong(false);
              if (!busy) setDemo(null);
            }}
            onEnter={() => void submit()}
            invalid={wrong}
            className="w-full"
          />
        </div>
        {demo && (
          <span role="status" className={`text-xs ${demo === "starting" ? "text-muted" : "text-neg"}`}>
            {demo === "starting" ? "Starting the demo…" : demo}
          </span>
        )}
        {wrong && (
          <span role="alert" className="sr-only">
            Wrong password
          </span>
        )}
      </div>
    </div>
  );
}
