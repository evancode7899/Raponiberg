import { describe, expect, it } from "vitest";
import { beforeAfterOf, changesOf, MAX_CHANGES } from "./changes";
import { canonicalJson, CHAIN_KEY, checkChain, GENESIS, nextLink, splitLink, withLink, type ChainLink, type StoredEvent } from "./chain";

/** Invented events, chained as logAuditEvent writes them. */
function chainOf(n: number, start: ChainLink | null = null, t0 = Date.parse("2031-03-01T12:00:00Z")): StoredEvent[] {
  let last = start;
  return Array.from({ length: n }, (_, i) => {
    const occurredAt = new Date(t0 + i * 60_000).toISOString();
    const payload = i % 3 === 2 ? "a plain value" : { goal: "Emergency fund", n: i, nested: { b: 2, a: 1 } };
    const link = nextLink(last, { occurredAt, action: "goals_updated", actor: "app", payload, correlationId: null });
    last = link;
    return { id: `ev${i}`, occurredAt, action: "goals_updated", actor: "app", payloadJson: withLink(payload, link), correlationId: null };
  });
}

const anchorOf = (events: StoredEvent[]) => {
  const l = splitLink(events.at(-1)!.payloadJson).link!;
  return { seq: l.seq, hash: l.hash, at: "" };
};

describe("the audit chain", () => {
  it("writes keys in one order, so the same event always hashes the same", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
  });

  it("holds when nothing was touched, and keeps each event's own payload apart from its link", () => {
    const ev = chainOf(6);
    expect(checkChain(ev, anchorOf(ev))).toMatchObject({ ok: true, chained: 6, unchained: 0, head: { seq: 6 }, problems: [] });
    expect(splitLink(ev[2]!.payloadJson)).toEqual({ payload: "a plain value", link: expect.objectContaining({ seq: 3 }) });
    expect(splitLink(ev[0]!.payloadJson).payload).toEqual({ goal: "Emergency fund", n: 0, nested: { b: 2, a: 1 } });
    expect(splitLink(ev[0]!.payloadJson).link!.prev).toBe(GENESIS);
  });

  it("counts events from before the chain began without calling them broken", () => {
    const ev = [{ id: "old", occurredAt: "2031-02-01T00:00:00Z", action: "car_updated", actor: "app", payloadJson: { cars: 1 } }, ...chainOf(3)];
    expect(checkChain(ev, anchorOf(ev))).toMatchObject({ ok: true, chained: 3, unchained: 1 });
  });

  it("shows an edited payload, action or time", () => {
    for (const edit of [
      (e: StoredEvent) => ({ ...e, payloadJson: { ...(e.payloadJson as object), n: 99 } }),
      (e: StoredEvent) => ({ ...e, action: "car_updated" }),
      (e: StoredEvent) => ({ ...e, occurredAt: "2031-03-01T13:00:00.000Z" }),
    ]) {
      const ev = chainOf(5);
      ev[1] = edit(ev[1]!);
      const c = checkChain(ev, anchorOf(ev));
      expect(c.ok).toBe(false);
      expect(c.problems[0]).toMatchObject({ kind: "edited", seq: 2, eventId: "ev1" });
    }
  });

  it("shows a deleted event, a swapped one, and the newest ones cut off", () => {
    const ev = chainOf(5);
    expect(checkChain([...ev.slice(0, 2), ...ev.slice(3)], anchorOf(ev)).problems).toEqual([expect.objectContaining({ kind: "missing", seq: 4 })]);
    const other = chainOf(5, null, Date.parse("2031-04-01T00:00:00Z"));
    const swapped = [...ev.slice(0, 2), { ...other[2]!, payloadJson: other[2]!.payloadJson }, ...ev.slice(3)];
    expect(checkChain(swapped, anchorOf(ev)).problems.map((p) => p.kind)).toContain("reordered");
    expect(checkChain(ev.slice(0, 3), anchorOf(ev)).problems).toEqual([expect.objectContaining({ kind: "cut-off", seq: 5 })]);
    expect(checkChain(ev.slice(1), anchorOf(ev)).problems).toEqual([expect.objectContaining({ kind: "missing", seq: 2 })]);
  });

  it("notes a chain started again from nothing", () => {
    const ev = [...chainOf(2), ...chainOf(2, null, Date.parse("2031-05-01T00:00:00Z")).map((e, i) => ({ ...e, id: `new${i}` }))];
    const c = checkChain(ev, null);
    expect(c.restarts).toHaveLength(1);
    expect(CHAIN_KEY).toBe("#chain");
  });
});

describe("before and after", () => {
  it("lists only what changed, matching list items by id or name", () => {
    const before = { targets: { Dining: 40_000, Groceries: 60_000 }, goals: [{ name: "Car", amount: 1 }, { name: "Trip", amount: 2 }] };
    const after = { targets: { Dining: 45_000, Groceries: 60_000, Travel: 10_000 }, goals: [{ name: "Trip", amount: 3 }, { name: "Car", amount: 1 }] };
    expect(changesOf(before, after)).toEqual([
      { path: "goals[Trip].amount", before: 2, after: 3 },
      { path: "targets.Dining", before: 40_000, after: 45_000 },
      { path: "targets.Travel", before: null, after: 10_000 },
    ]);
    expect(changesOf({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("caps a big change and says how many more", () => {
    const after = Object.fromEntries(Array.from({ length: MAX_CHANGES + 5 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i]));
    const c = changesOf({}, after);
    expect(c).toHaveLength(MAX_CHANGES + 1);
    expect(c.at(-1)!.path).toBe("…and 5 more");
  });

  it("reads before and after from a payload's changes and its { from, to } members", () => {
    expect(beforeAfterOf({ view: { from: "STRICT", to: "PRO_FORMA" }, changes: [{ path: "x", before: 1, after: 2 }] })).toEqual([
      { path: "x", before: 1, after: 2 },
      { path: "view", before: "STRICT", after: "PRO_FORMA" },
    ]);
    expect(beforeAfterOf("plain")).toEqual([]);
  });
});
