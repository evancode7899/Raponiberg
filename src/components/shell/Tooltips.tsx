"use client";

import { useEffect, useRef, useState } from "react";

type Tip = { text: string; x: number; y: number; above: boolean };

const DELAY_MS = 180;
const GAP = 6;

/**
 * One tooltip for the whole app. Pages say what something means with a plain `title`; the
 * browser shows that late, small, and never to the keyboard. This takes the title over while
 * the pointer or the focus is on it, shows it at once in the app's own style, and puts it back
 * after, so a page needs nothing new and a screen reader still finds the title.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let on: HTMLElement | null = null;
    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const leave = () => {
      clearTimeout(timer);
      // Put back unless the page has drawn a new one meanwhile.
      if (on && text && !on.hasAttribute("title")) on.setAttribute("title", text);
      on = null;
      text = "";
      setTip(null);
    };
    const enter = (target: EventTarget | null, delay: number) => {
      const el = target instanceof Element ? target.closest<HTMLElement>("[title]") : null;
      if (el === on && el) return;
      if (!el) {
        if (!(target instanceof Node) || !on?.contains(target)) leave();
        return;
      }
      leave();
      const t = el.getAttribute("title")?.trim();
      if (!t || el.tagName === "IFRAME") return;
      on = el;
      text = t;
      el.removeAttribute("title");
      timer = setTimeout(() => {
        if (!el.isConnected) return leave();
        const r = el.getBoundingClientRect();
        const above = r.bottom + 120 > window.innerHeight && r.top > 140;
        setTip({ text: t, x: r.left + Math.min(r.width / 2, 160), y: above ? r.top - GAP : r.bottom + GAP, above });
      }, delay);
    };
    const over = (e: PointerEvent) => e.pointerType !== "touch" && enter(e.target, DELAY_MS);
    const out = (e: PointerEvent) => {
      if (on && !(e.relatedTarget instanceof Node && on.contains(e.relatedTarget))) leave();
    };
    const focus = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.matches(":focus-visible")) enter(e.target, DELAY_MS);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && leave();

    // A hint shown by pointing (cursor-help: a badge, an ⓘ) takes a Tab stop too, so the keyboard reaches what the mouse does.
    const reach = () => {
      for (const el of document.querySelectorAll<HTMLElement>(".cursor-help:not([tabindex]):not(a, button, input, select, textarea)")) if (el.closest("[title]")) el.tabIndex = 0;
    };
    let queued = 0;
    const watch = new MutationObserver(() => {
      if (!queued) queued = requestAnimationFrame(() => ((queued = 0), reach()));
    });
    reach();
    watch.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", leave);
    document.addEventListener("scroll", leave, true);
    document.addEventListener("keydown", key);
    return () => {
      watch.disconnect();
      cancelAnimationFrame(queued);
      leave();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", leave);
      document.removeEventListener("scroll", leave, true);
      document.removeEventListener("keydown", key);
    };
  }, []);

  // Kept inside the window once its width is known.
  useEffect(() => {
    const el = box.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, tip.x - w / 2))}px`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={box}
      role="tooltip"
      data-tooltip=""
      className="pointer-events-none fixed z-[400] max-w-[26rem] whitespace-pre-line rounded border border-line-strong bg-surface-2 px-2 py-1 text-xs leading-snug text-fg shadow-lg"
      style={{ left: tip.x, top: tip.y, transform: tip.above ? "translateY(-100%)" : undefined }}
    >
      {tip.text}
    </div>
  );
}
