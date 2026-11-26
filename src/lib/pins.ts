import path from "node:path";
import { dataDir } from "./dataDir.ts";
import { appendJournal, journalPathOf, readJsonStore, writeJsonAtomic } from "./jsonStore.ts";

/**
 * The owner's saved views and pinned figures, in data/pins.json (backed up with the rest of
 * the data folder; no figure reads it: lib/appFiles.ts). A view is a page, its tab and its
 * filters, by address; a pinned figure is a proof's recipe, so it opens the same proof
 * whatever the data says now. The command line finds both by name; the proof drawer pins
 * figures, and shows two of them side by side.
 */

export type SavedView = { kind: "view"; name: string; href: string; at: string };
export type PinnedFigure = { kind: "figure"; name: string; descriptor: Record<string, unknown>; at: string };
export type Pin = SavedView | PinnedFigure;
type PinsFile = { version: 1; pins: Pin[] };

const MAX_PINS = 200;
const MAX_NAME = 80;
const MAX_DESCRIPTOR = 8000;

export const pinsFilePath = () => path.join(dataDir(), "pins.json");

/** The pins in a file: none when there is no file; a damaged one is an error, never read as none. */
export function readPins(file = pinsFilePath()): Pin[] {
  const f = readJsonStore<Partial<PinsFile>>(file, () => ({ version: 1, pins: [] }), { journal: journalPathOf(file) });
  if (typeof f.version === "number" && f.version > 1) throw new Error("pins.json was written by a newer version of the app.");
  return (Array.isArray(f.pins) ? f.pins : []).filter(isPin);
}

function isPin(p: unknown): p is Pin {
  if (!p || typeof p !== "object") return false;
  const x = p as Record<string, unknown>;
  if (typeof x.name !== "string" || typeof x.at !== "string") return false;
  if (x.kind === "view") return typeof x.href === "string";
  return x.kind === "figure" && !!x.descriptor && typeof x.descriptor === "object";
}

/** A view's address must be one of the app's own pages: a path, never another site. */
export function isAppHref(href: string): boolean {
  return /^\/(?!\/)[\w\-/]*(\?[^\s#]*)?$/.test(href) && href.length <= 600;
}

/** Checks what a page sends and makes it a pin (throws on anything else). */
export function toPin(body: unknown, now = new Date()): Pin {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > MAX_NAME) throw new Error(`Give it a name (up to ${MAX_NAME} characters).`);
  const at = now.toISOString();
  if (b.kind === "view") {
    if (typeof b.href !== "string" || !isAppHref(b.href)) throw new Error("A view is a page of this app.");
    return { kind: "view", name, href: b.href, at };
  }
  if (b.kind === "figure") {
    if (!b.descriptor || typeof b.descriptor !== "object" || typeof (b.descriptor as { report?: unknown }).report !== "string") throw new Error("A pinned figure needs its proof's recipe.");
    if (JSON.stringify(b.descriptor).length > MAX_DESCRIPTOR) throw new Error("That figure's recipe is too long to pin.");
    return { kind: "figure", name, descriptor: b.descriptor as Record<string, unknown>, at };
  }
  throw new Error("Pin a view or a figure.");
}

/** Adds a pin, replacing one of the same kind and name. */
export function addPin(pin: Pin, file = pinsFilePath()): Pin[] {
  const same = (p: Pin) => p.kind === pin.kind && p.name.toLowerCase() === pin.name.toLowerCase();
  const pins = [...readPins(file).filter((p) => !same(p)), pin].slice(-MAX_PINS);
  appendJournal(journalPathOf(file), { op: "add", pin });
  writeJsonAtomic(file, { version: 1, pins } satisfies PinsFile);
  return pins;
}

/** Takes a pin off (by kind and name). */
export function removePin(kind: Pin["kind"], name: string, file = pinsFilePath()): Pin[] {
  const pins = readPins(file);
  const left = pins.filter((p) => !(p.kind === kind && p.name.toLowerCase() === name.toLowerCase()));
  if (left.length === pins.length) return pins;
  appendJournal(journalPathOf(file), { op: "remove", kind, name });
  writeJsonAtomic(file, { version: 1, pins: left } satisfies PinsFile);
  return left;
}
