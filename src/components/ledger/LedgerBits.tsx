"use client";

import { inputCls } from "@/components/ui/kit";
import type { Api } from "./useApi";

export { buttonDanger, buttonPrimary, buttonSecondary, Card, Segmented, Stat } from "@/components/ui/kit";

/** Shown only when the server requires API_SECRET; remembered for the browser session. */
export function ApiSecretField({ api }: { api: Api }) {
  if (!api.requiresApiSecret) return null;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <label className="flex max-w-md flex-col gap-1 text-xs">
        <span className="font-medium text-fg-2">Access secret</span>
        <input type="password" autoComplete="off" className={inputCls} value={api.secret} onChange={(e) => api.setSecret(e.target.value)} />
        <span className="text-muted">This server requires API_SECRET. It&apos;s kept for this browser session only.</span>
      </label>
    </div>
  );
}
