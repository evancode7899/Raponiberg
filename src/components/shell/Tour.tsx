"use client";

import { btn } from "@/components/ui/kit";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** Starts the tour again (the command line's TOUR). */
export const TOUR_EVENT = "pf:tour";
const DONE_KEY = "pf-tour-done";

/** The tour's stops: what to point at (the first match that is drawn), and what it says. */
export const TOUR_STEPS: { at: string; title: string; text: string }[] = [
  { at: "header [data-command-root]", title: "The command line", text: "Type a code (NW, CF, TAX) or words: a page, a tab, an account, a merchant or a figure by name. CF 24M DINING, SPLIT TAX, SAVE name. Ctrl K or / gets here from anywhere." },
  { at: "nav[aria-label='Main']", title: "Every page, in five groups", text: "Each page has a code beside its name. G then a letter jumps there by keyboard; ? lists every key." },
  { at: "main [data-proof-key]", title: "Every number has a proof", text: "Click any figure for the statement rows and checks behind it. A figure shows only after the proof sweep has held it to its proof; n.a. means it's withheld, and says why." },
  { at: "main [data-panel], main section", title: "Dense panels", text: "Arrow keys or H J K L move between panels and rows, Enter opens one, : opens a panel's own command line, Space on a month or category links the other panels to it." },
  { at: "header button[aria-label='Hide amounts'], header button[aria-label='Show amounts']", title: "Hide amounts", text: "Blurs every figure on screen, for when someone is looking over your shoulder." },
  { at: "nav a[href='/statements']", title: "Where the data comes from", text: "Statements are the only source: import them here, and see what's missing or failing. This demo is a made-up household; your own data never comes here." },
];

function findTarget(sel: string): HTMLElement | null {
  for (const one of sel.split(", ")) {
    const el = [...document.querySelectorAll<HTMLElement>(one)].find((e) => e.getClientRects().length > 0);
    if (el) return el;
  }
  return null;
}

/**
 * A short guided tour, offered once on the demo (made-up data, so trying things is safe) and
 * again by typing TOUR. It points at one thing at a time; Next, Back, Esc or Skip, all by keyboard.
 * Nothing moves: the box simply appears at each stop.
 */
export function Tour({ auto }: { auto: boolean }) {
  const [step, setStep] = useState<number | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  useEffect(() => {
    const start = () => setStep(0);
    window.addEventListener(TOUR_EVENT, start);
    let seen = true;
    try {
      seen = localStorage.getItem(DONE_KEY) === "1";
    } catch {
      /* storage unavailable */
    }
    const t = auto && !seen ? setTimeout(start, 1200) : undefined;
    return () => {
      window.removeEventListener(TOUR_EVENT, start);
      clearTimeout(t);
    };
  }, [auto]);
  const end = useCallback(() => {
    setStep(null);
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {
      /* storage unavailable */
    }
  }, []);
  useLayoutEffect(() => {
    if (step == null) return;
    const el = findTarget(TOUR_STEPS[step]!.at);
    el?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- where the stop is on screen is known only after layout
    setBox(el ? el.getBoundingClientRect() : null);
  }, [step]);
  useEffect(() => {
    if (step == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        end();
      } else if (e.key === "ArrowRight") setStep((s) => (s! + 1 < TOUR_STEPS.length ? s! + 1 : s));
      else if (e.key === "ArrowLeft") setStep((s) => Math.max(0, s! - 1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, end]);
  if (step == null) return null;
  const s = TOUR_STEPS[step]!;
  const last = step === TOUR_STEPS.length - 1;
  const below = !box || box.bottom + 180 < window.innerHeight;
  const left = box ? Math.max(8, Math.min(window.innerWidth - 368, box.left)) : window.innerWidth / 2 - 180;
  const top = box ? (below ? box.bottom + 8 : Math.max(8, box.top - 8)) : window.innerHeight / 3;
  return (
    <div className="pointer-events-none fixed inset-0 z-[380]">
      {box && <div aria-hidden className="absolute rounded-sm outline outline-2 outline-accent" style={{ left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6 }} />}
      <div
        role="dialog"
        aria-label={`Tour, ${step + 1} of ${TOUR_STEPS.length}: ${s.title}`}
        className="pointer-events-auto absolute w-[22.5rem] rounded-md border border-accent bg-surface-2 p-3 text-[13px] shadow-2xl"
        style={{ left, top, transform: below ? undefined : "translateY(-100%)" }}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xs font-bold text-accent">
            {step + 1}/{TOUR_STEPS.length}
          </span>
          <h2 className="font-semibold text-fg">{s.title}</h2>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-fg-2">{s.text}</p>
        <div className="mt-3 flex items-center gap-2">
          <button type="button" className={btn.link} onClick={end}>
            Skip the tour
          </button>
          <span className="ml-auto" />
          {step > 0 && (
            <button type="button" className={btn.ghost} onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button type="button" autoFocus className={btn.primary} onClick={() => (last ? end() : setStep(step + 1))}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
