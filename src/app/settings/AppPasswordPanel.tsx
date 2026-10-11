"use client";

import type { Api } from "@/components/ledger/useApi";
import { btn, Card, SecretBox } from "@/components/ui/kit";
import { useEffect, useState } from "react";

/** Settings › General: change the lock screen's password (lib/appPassword.ts). */
export function AppPasswordPanel({ api }: { api: Api }) {
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "pos" | "neg"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/app-password")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { isDefault?: boolean } | null) => j && setIsDefault(Boolean(j.isDefault)))
      .catch(() => {});
  }, []);

  const mismatch = confirm.length > 0 && next !== confirm;

  const save = async () => {
    if (busy || !next || next !== confirm) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.call("/api/app-password", { method: "PUT", json: { password: next } });
      setNext("");
      setConfirm("");
      setIsDefault(next === "password");
      setMsg({ tone: "pos", text: "Saved. You'll need the new password next time the app opens." });
    } catch (err) {
      setMsg({ tone: "neg", text: err instanceof Error ? err.message : "Could not save" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="App password"
      subtitle={
        <>
          The lock screen asks for this once per browser session. It only keeps out someone casually using this laptop: it is stored in plain text in{" "}
          <code className="font-mono">data/app-password.json</code>, and deleting that file puts back the default.
          {isDefault && (
            <>
              {" "}
              <span className="font-medium text-warn">You&apos;re still on the default password (&quot;password&quot;).</span>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-48 flex-col gap-1 text-xs">
          <span id="app-password-new" className="font-medium text-fg-2">
            New password
          </span>
          <SecretBox labelledBy="app-password-new" value={next} onChange={setNext} onEnter={() => void save()} />
        </div>
        <div className="flex w-48 flex-col gap-1 text-xs">
          <span id="app-password-confirm" className="font-medium text-fg-2">
            Confirm
          </span>
          <SecretBox labelledBy="app-password-confirm" value={confirm} onChange={setConfirm} onEnter={() => void save()} invalid={mismatch} />
        </div>
        <button type="button" onClick={() => void save()} className={btn.primary} disabled={busy || !next || next !== confirm}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </div>
      {mismatch && <p className="mt-2 text-xs text-neg">The two don&apos;t match.</p>}
      {msg && <p className={`mt-2 text-xs ${msg.tone === "pos" ? "text-pos" : "text-neg"}`}>{msg.text}</p>}
    </Card>
  );
}
