import { createHash } from "node:crypto";

/**
 * The audit log as a hash chain. Each event carries a link in its payload (CHAIN_KEY): its
 * place in the chain (seq), the hash of the event before it (prev) and its own hash, taken
 * over everything the event says (when, what, who, the payload) plus prev. Editing an event
 * changes its hash; deleting or reordering one breaks the next event's prev. The newest
 * link is also kept outside the database (audit-head.json in the data folder), so cutting
 * events off the end shows too.
 *
 * No schema change: the link lives in the event's JSON payload, and a payload that isn't an
 * object is kept under VALUE_KEY beside it. Events written before the chain began carry no
 * link and are counted as such, never as broken.
 */
export const CHAIN_KEY = "#chain";
export const VALUE_KEY = "#value";
/** The prev of the first event of a chain. */
export const GENESIS = "genesis";

export type ChainLink = { seq: number; prev: string; hash: string };
export type AuditHead = { seq: number; hash: string; at: string };

/** What an event says, as it is hashed. */
export type ChainedFields = { occurredAt: string; action: string; actor: string; payload: unknown; correlationId: string | null };

/** JSON with every object's keys in order, so the same event always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function linkHash(seq: number, prev: string, f: ChainedFields): string {
  // As stored: a JSON round trip drops undefined members and turns dates into strings.
  const payload = f.payload === undefined ? null : JSON.parse(JSON.stringify(f.payload));
  return createHash("sha256")
    .update(canonicalJson({ seq, prev, occurredAt: f.occurredAt, action: f.action, actor: f.actor, payload, correlationId: f.correlationId ?? null }))
    .digest("hex");
}

/** The payload to store: the event's own payload with its link beside it. */
export function withLink(payload: unknown, link: ChainLink): Record<string, unknown> {
  const own = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : payload === undefined || payload === null ? {} : { [VALUE_KEY]: payload };
  return { ...own, [CHAIN_KEY]: link };
}

/** A stored payload taken apart: the event's own payload, and its link if it has one. */
export function splitLink(stored: unknown): { payload: unknown; link: ChainLink | null } {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored) || !(CHAIN_KEY in stored)) return { payload: stored ?? null, link: null };
  const { [CHAIN_KEY]: raw, ...rest } = stored as Record<string, unknown>;
  const link = raw as ChainLink;
  const payload = VALUE_KEY in rest && Object.keys(rest).length === 1 ? rest[VALUE_KEY] : Object.keys(rest).length ? rest : null;
  return { payload, link: link && typeof link.seq === "number" && typeof link.hash === "string" ? link : null };
}

/** The next link after `last` (null starts a chain). */
export function nextLink(last: ChainLink | null, f: ChainedFields): ChainLink {
  const seq = (last?.seq ?? 0) + 1;
  const prev = last?.hash ?? GENESIS;
  return { seq, prev, hash: linkHash(seq, prev, f) };
}

export type StoredEvent = { id: string; occurredAt: Date | string; action: string; actor: string; payloadJson: unknown; correlationId?: string | null };

export type ChainProblem = { kind: "edited" | "missing" | "reordered" | "cut-off" | "anchor-mismatch"; seq: number | null; eventId: string | null; detail: string };

export type ChainCheck = {
  /** Events with a link, and those from before the chain began. */
  chained: number;
  unchained: number;
  /** The newest link, and when the chain (re)started. */
  head: { seq: number; at: string } | null;
  startedAt: string | null;
  /** Where the chain was started again from nothing (a database wipe or import brings its own log). */
  restarts: { at: string; action: string }[];
  ok: boolean;
  problems: ChainProblem[];
};

const iso = (d: Date | string) => (typeof d === "string" ? new Date(d).toISOString() : d.toISOString());

/**
 * Walks the chain in order and says whether it holds: every event's hash matches what it
 * says, each prev is the hash before it, no seq is skipped, and the newest link is the one
 * the data folder's anchor names. Reports problems; never repairs.
 */
export function checkChain(events: StoredEvent[], anchor: AuditHead | null): ChainCheck {
  const linked = events
    .map((e) => ({ e, ...splitLink(e.payloadJson) }))
    .filter((x) => x.link)
    .sort((a, b) => a.link!.seq - b.link!.seq || iso(a.e.occurredAt).localeCompare(iso(b.e.occurredAt)));
  const problems: ChainProblem[] = [];
  const restarts: ChainCheck["restarts"] = [];
  let before: ChainLink | null = null;
  for (const { e, payload, link } of linked) {
    const l = link!;
    const fields: ChainedFields = { occurredAt: iso(e.occurredAt), action: e.action, actor: e.actor, payload, correlationId: e.correlationId ?? null };
    if (linkHash(l.seq, l.prev, fields) !== l.hash) problems.push({ kind: "edited", seq: l.seq, eventId: e.id, detail: `Event ${l.seq} (${e.action}) no longer matches its hash: it was changed after it was written.` });
    if (l.prev === GENESIS) {
      if (before) restarts.push({ at: fields.occurredAt, action: e.action });
    } else if (!before) {
      problems.push({ kind: "missing", seq: l.seq, eventId: e.id, detail: `The events before ${l.seq} are gone.` });
    } else if (l.seq !== before.seq + 1) {
      problems.push({ kind: l.seq === before.seq ? "reordered" : "missing", seq: l.seq, eventId: e.id, detail: l.seq === before.seq ? `Two events claim place ${l.seq}.` : `Events ${before.seq + 1} to ${l.seq - 1} are missing.` });
    } else if (l.prev !== before.hash) {
      problems.push({ kind: "reordered", seq: l.seq, eventId: e.id, detail: `Event ${l.seq} doesn't follow event ${before.seq}: one of them was replaced.` });
    }
    before = l;
  }
  const last = linked.at(-1);
  if (anchor && last) {
    if (anchor.seq > last.link!.seq) problems.push({ kind: "cut-off", seq: anchor.seq, eventId: null, detail: `The log ends at event ${last.link!.seq}, but event ${anchor.seq} was written: the newest events were removed.` });
    else if (anchor.seq === last.link!.seq && anchor.hash !== last.link!.hash) problems.push({ kind: "anchor-mismatch", seq: anchor.seq, eventId: last.e.id, detail: `Event ${anchor.seq} isn't the one that was written.` });
  } else if (anchor && !last && anchor.seq > 0) {
    problems.push({ kind: "cut-off", seq: anchor.seq, eventId: null, detail: `Event ${anchor.seq} was written, but the log holds no chained events.` });
  }
  const start = [...linked].reverse().find((x) => x.link!.prev === GENESIS);
  return {
    chained: linked.length,
    unchained: events.length - linked.length,
    head: last ? { seq: last.link!.seq, at: iso(last.e.occurredAt) } : null,
    startedAt: start ? iso(start.e.occurredAt) : null,
    restarts,
    ok: problems.length === 0,
    problems,
  };
}
