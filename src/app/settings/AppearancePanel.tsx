"use client";

import { Card } from "@/components/ui/kit";
import { applyFontScale, applyTheme, isAppTheme, isFontScale, type AppTheme, type FontScale } from "@/lib/preferences";
import { useEffect, useState } from "react";

const THEMES: { id: AppTheme; label: string; note: string; swatch: [string, string, string] }[] = [
  { id: "bloomberg", label: "Terminal", note: "Black field, amber accent, monospace", swatch: ["#05070a", "#0d1117", "#ffa028"] },
  { id: "dark", label: "Dark", note: "Soft dark, sans-serif", swatch: ["#121211", "#1a1a19", "#f08a4b"] },
  { id: "light", label: "Light", note: "Paper white, sans-serif", swatch: ["#f4f4f2", "#ffffff", "#c2410c"] },
];

const SIZES: { id: FontScale; label: string; sample: string }[] = [
  { id: "sm", label: "Compact", sample: "text-[12px]" },
  { id: "md", label: "Default", sample: "text-[13px]" },
  { id: "lg", label: "Large", sample: "text-[15px]" },
];

export function AppearancePanel() {
  const [theme, setTheme] = useState<AppTheme>("bloomberg");
  const [size, setSize] = useState<FontScale>("md");
  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount: the theme attributes are set on <html> by a script before hydration
    if (isAppTheme(t)) setTheme(t);
    const f = document.documentElement.getAttribute("data-font-scale");
    if (isFontScale(f)) setSize(f);
  }, []);

  return (
    <>
      <Card title="Theme" subtitle="Applies immediately and is remembered in this browser. You can also switch from the top bar.">
        <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => {
            const on = theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setTheme(t.id);
                  applyTheme(t.id);
                }}
                className={`flex flex-col gap-2 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus ${
                  on ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-surface-2"
                }`}
              >
                <div className="flex h-14 overflow-hidden rounded border border-line" style={{ background: t.swatch[0] }} aria-hidden>
                  <div className="m-1.5 w-1/3 rounded-sm" style={{ background: t.swatch[1] }} />
                  <div className="my-1.5 mr-1.5 flex flex-1 flex-col gap-1 rounded-sm p-1.5" style={{ background: t.swatch[1] }}>
                    <div className="h-1.5 w-2/3 rounded-full" style={{ background: t.swatch[2] }} />
                    <div className="h-1 w-1/2 rounded-full bg-gray-500/50" />
                  </div>
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-fg">{t.label}</div>
                  <div className="text-xs text-muted">{t.note}</div>
                </div>
              </button>
            );
          })}
        </div>
      </Card>
      <Card title="Text size">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Text size">
          {SIZES.map((s) => {
            const on = size === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setSize(s.id);
                  applyFontScale(s.id);
                }}
                className={`rounded-md border px-4 py-2 outline-none focus-visible:ring-2 focus-visible:ring-focus ${s.sample} ${
                  on ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-2 hover:bg-surface-2"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </Card>
      <Card title="Keyboard">
        <ul className="grid gap-2 text-[13px] text-fg-2 sm:grid-cols-2">
          <li>
            <kbd className="rounded border border-line-strong px-1.5 font-mono text-xs">Ctrl K</kbd> or <kbd className="rounded border border-line-strong px-1.5 font-mono text-xs">/</kbd>{" "}
            — jump to the command bar
          </li>
          <li>
            Type a mnemonic (<span className="font-mono text-accent">NW</span>, <span className="font-mono text-accent">TXN</span>…) and press Enter
          </li>
          <li>
            <kbd className="rounded border border-line-strong px-1.5 font-mono text-xs">Esc</kbd> — close a panel or the command list
          </li>
          <li>
            <span className="font-mono text-accent">HELP</span> — every function and its mnemonic
          </li>
        </ul>
      </Card>
    </>
  );
}
