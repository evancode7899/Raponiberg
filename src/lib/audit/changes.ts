/**
 * What a saved change actually changed, for the audit log's before and after: every value
 * that differs between what was there and what was saved, by where it sits ("targets.Dining",
 * "goals[Emergency fund].amount"). Lists of things with an id or a name are matched by it, so
 * moving one item isn't read as changing every item after it. Capped, with the rest counted.
 */
export type Change = { path: string; before: unknown; after: unknown };

export const MAX_CHANGES = 40;
/** A long value is cut down in the log: it says what changed, not the whole store. */
const MAX_TEXT = 300;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keyOf(item: unknown): string | null {
  if (!isObj(item)) return null;
  for (const k of ["id", "key", "name", "label"]) if (typeof item[k] === "string" || typeof item[k] === "number") return String(item[k]);
  return null;
}

function short(v: unknown): unknown {
  if (v === undefined) return null;
  const text = JSON.stringify(v);
  return text && text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : v;
}

function walk(before: unknown, after: unknown, at: string, out: Change[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (isObj(before) && isObj(after)) {
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) walk(before[k], after[k], at ? `${at}.${k}` : k, out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const keys = [...before, ...after].map(keyOf);
    if (keys.every((k) => k !== null) && new Set(before.map(keyOf)).size === before.length && new Set(after.map(keyOf)).size === after.length) {
      const b = new Map(before.map((x) => [keyOf(x)!, x]));
      const a = new Map(after.map((x) => [keyOf(x)!, x]));
      for (const k of [...new Set([...b.keys(), ...a.keys()])]) walk(b.get(k), a.get(k), `${at}[${k}]`, out);
      return;
    }
    for (let i = 0; i < Math.max(before.length, after.length); i++) walk(before[i], after[i], `${at}[${i}]`, out);
    return;
  }
  out.push({ path: at || "(all)", before: short(before), after: short(after) });
}

export function changesOf(before: unknown, after: unknown): Change[] {
  const out: Change[] = [];
  walk(JSON.parse(JSON.stringify(before ?? null)), JSON.parse(JSON.stringify(after ?? null)), "", out);
  if (out.length <= MAX_CHANGES) return out;
  return [...out.slice(0, MAX_CHANGES), { path: `…and ${out.length - MAX_CHANGES} more`, before: null, after: null }];
}

/** The before-and-after pairs an event's payload holds: its changes list, and any { from, to } member. */
export function beforeAfterOf(payload: unknown): Change[] {
  if (!isObj(payload)) return [];
  const out: Change[] = Array.isArray(payload.changes) ? (payload.changes as Change[]).filter((c) => isObj(c) && typeof c.path === "string") : [];
  for (const [k, v] of Object.entries(payload)) if (isObj(v) && "from" in v && "to" in v && Object.keys(v).length === 2) out.push({ path: k, before: v.from, after: v.to });
  return out;
}
