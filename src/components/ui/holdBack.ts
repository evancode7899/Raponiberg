"use client";

import { notify } from "./Feedback";

/**
 * A change shown at once and sent a moment later, with Undo in between: for a change the
 * server can't take back by itself (a document deleted, a transfer decision). The page draws
 * it as done straight away (`hide`); Undo within the moment puts the page back (`show`) and
 * nothing was sent. When the moment passes it's sent; if the server refuses, the page is put
 * back and says why. Leaving the page meanwhile sends it then (keepalive), as it was meant.
 */
export type HeldChange = {
  /** What the toast says was done ("Deleted Example Bank statement"). */
  say: string;
  /** Draws the change on the page now. */
  hide: () => void;
  /** Puts the page back (Undo, or the server refused). */
  show: () => void;
  /** Sends it. `keepalive` is set when the page is going away, so the request outlives it. */
  commit: (opts: { keepalive: boolean }) => Promise<unknown>;
  /** After it was sent and kept. */
  done?: () => void;
};

/** How long Undo stays open before the change is sent (the toast with Undo stays as long). */
export const HOLD_MS = 10_000;

const held = new Map<number, { change: HeldChange; timer: ReturnType<typeof setTimeout> }>();
let seq = 0;

async function send(id: number, keepalive: boolean) {
  const h = held.get(id);
  if (!h) return;
  held.delete(id);
  clearTimeout(h.timer);
  try {
    await h.change.commit({ keepalive });
    h.change.done?.();
  } catch (e) {
    h.change.show();
    notify(`${h.change.say}: not done. ${e instanceof Error ? e.message : ""}`.trim(), { tone: "bad" });
  }
}

if (typeof window !== "undefined") {
  // Going away with a change still held: it was meant, so it's sent now.
  window.addEventListener("pagehide", () => {
    for (const id of [...held.keys()]) void send(id, true);
  });
}

/** Shows a change now and sends it after HOLD_MS, with Undo until then. */
export function holdBack(change: HeldChange, ms = HOLD_MS): void {
  const id = ++seq;
  change.hide();
  held.set(id, { change, timer: setTimeout(() => void send(id, false), ms) });
  notify(change.say, {
    undo: () => {
      const h = held.get(id);
      if (!h) throw new Error("Too late to undo: it was already sent.");
      clearTimeout(h.timer);
      held.delete(id);
      change.show();
      notify("Undone: nothing was changed.", { tone: "info" });
    },
  });
}

/** How many changes are still held (tests; the shell could warn before closing). */
export const heldCount = () => held.size;
