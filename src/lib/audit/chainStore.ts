import type { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { writeJsonAtomic } from "../jsonStore.ts";
import { changesOf, type Change } from "./changes.ts";
import { nextLink, splitLink, withLink, type AuditHead, type ChainLink } from "./chain.ts";

/**
 * Writing onto the audit chain (chain.ts): one event at a time, each linked to the newest
 * in the database, and the newest link kept in the data folder as well. Relative imports
 * only, so the import scripts can write the events of what they commit too.
 */

/** The chain's newest link, kept outside the database (chain.ts): a log cut short shows. No figure reads it (lib/appFiles.ts). */
export const auditHeadPath = () => path.join(dataDir(), "audit-head.json");

export function readAuditHead(file = auditHeadPath()): AuditHead | null {
  try {
    const h = JSON.parse(readFileSync(file, "utf8")) as Partial<AuditHead>;
    return typeof h.seq === "number" && typeof h.hash === "string" ? { seq: h.seq, hash: h.hash, at: String(h.at ?? "") } : null;
  } catch {
    return null;
  }
}

// One event at a time in this process, so two never take the same place in the chain.
// On globalThis: every route's bundle shares the one queue.
const shared = globalThis as { __pfAuditChain?: Promise<unknown> };

/**
 * Runs `fn` with the chain to itself: nothing else in this process writes an audit event
 * until it's done. A transaction that writes its own event (an import) runs inside this.
 */
export function withAuditChain<T>(fn: () => Promise<T>): Promise<T> {
  const run = (shared.__pfAuditChain ?? Promise.resolve()).then(fn, fn);
  shared.__pfAuditChain = run.catch(() => {});
  return run;
}

type Db = Pick<Prisma.TransactionClient, "auditEvent">;

/** The newest link in the database: the chain goes on from there. */
async function lastLink(db: Db): Promise<ChainLink | null> {
  // Events are written one at a time, so the newest few hold the newest link.
  const recent = await db.auditEvent.findMany({ orderBy: { occurredAt: "desc" }, take: 50, select: { payloadJson: true } });
  let best: ChainLink | null = null;
  for (const r of recent) {
    const { link } = splitLink(r.payloadJson);
    if (link && (!best || link.seq > best.seq)) best = link;
  }
  return best;
}

export type AuditInput = {
  action: string;
  actor?: string;
  payload?: Prisma.InputJsonValue;
  correlationId?: string;
  /** What a change replaced and what it saved: the payload gets the differences (changes.ts) for the audit log to show before and after. */
  before?: unknown;
  after?: unknown;
};

/**
 * The event's database row, linked onto the chain. Call inside withAuditChain, with the
 * client the row is written with (a transaction's), then writeAuditHead once it's committed.
 */
export async function chainedAuditRow(db: Db, input: AuditInput): Promise<{ data: Prisma.AuditEventCreateInput; link: ChainLink }> {
  const occurredAt = new Date();
  const changes: Change[] | undefined = input.before !== undefined || input.after !== undefined ? changesOf(input.before, input.after) : undefined;
  const own = input.payload ?? null;
  const payload = changes ? { ...(own && typeof own === "object" && !Array.isArray(own) ? own : own == null ? {} : { value: own }), changes } : own;
  const actor = input.actor ?? "system";
  const link = nextLink(await lastLink(db), { occurredAt: occurredAt.toISOString(), action: input.action, actor, payload, correlationId: input.correlationId ?? null });
  return {
    data: { occurredAt, action: input.action, actor, payloadJson: withLink(payload, link) as Prisma.InputJsonValue, correlationId: input.correlationId },
    link,
  };
}

/** Moves the anchor to a link that is now in the database. Never fails the change it records. */
export function writeAuditHead(link: ChainLink, file = auditHeadPath()): void {
  try {
    writeJsonAtomic(file, { seq: link.seq, hash: link.hash, at: new Date().toISOString() } satisfies AuditHead);
  } catch {
    /* the anchor is a check, not the log: the next event writes it again */
  }
}

