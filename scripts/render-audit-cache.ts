/**
 * The render audit's cache (RENDER_AUDIT_CACHE=<folder>): what each tab drew last time, kept
 * with everything it was drawn from, so a tab whose inputs haven't changed isn't drawn again.
 *
 * A page in the browser is a function of what it was sent, its clock, its storage and its
 * window: the audit pins the clock, starts every unit with the same storage and window, and
 * the app draws nothing at random. So a unit's recording (scripts/render-audit-drive.ts) is
 * kept with every request its page made (the document, its scripts, each API read, each proof
 * a drawer asked for), and the answers' digests. Next time each is asked again, and if every
 * answer is the same, so is what the page would draw: the recording is used as if drawn now.
 * Any difference (new code in the page's scripts, new data in a report, a new proof) draws
 * the tab again. The recording is only what the browser saw: render-audit.ts holds it to the
 * proof sweep afresh on every run, so no verdict is ever kept.
 *
 * Four things the answers carry that aren't the data are read past: the data stamp (made from
 * the files' modified times, which move on every launch, lib/book/cache.ts), the build's id
 * (new on every build, even of the same code: Next's router only compares it with its own,
 * to tell another deployment's answers apart), the sweep's own timings, and Next's id for each
 * request (a React key, new on every answer). Everything else counts, byte for byte: a
 * script whose code changed has a new name, so the page that loads it asks for something new. A link's prefetch of another page counts only if the tab went there
 * (render-audit-drive.ts): the router uses a prefetched page only on arriving at it. render-audit.ts also draws a few kept
 * tabs again on every run (RENDER_AUDIT_RECHECK) and fails if any draws differently: the
 * check that nothing a page draws from was missed.
 *
 * The folder holds real figures on the owner's data (render-audit-real.ts keeps it in the
 * system temp folder, never in the repo).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tabKey, type Asked, type Unit, type UnitRun } from "./render-audit-drive.ts";

const VERSION = 2;
/** A kept tab: the code that drew it, how many parts it ran in, every answer it was drawn from, the data stamp then (proofs carry it), and the drawing. */
export type Entry = { v: number; driver: string; tab: string; unit: Unit; parts: number; answers: [Asked, string][]; stamp: string; run: UnitRun };

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const file = (dir: string, tab: string) => path.join(dir, `${sha(tab).slice(0, 24)}.json`);

/** Every kept entry, by tab (an unreadable one is just not kept). */
export function loadEntries(dir: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const e = JSON.parse(readFileSync(path.join(dir, n), "utf8")) as Entry;
      if (e.v === VERSION) out.set(e.tab, e);
    } catch {
      /* half-written or old: drawn again */
    }
  }
  return out;
}

export function saveEntry(dir: string, e: Omit<Entry, "v" | "tab">) {
  mkdirSync(dir, { recursive: true });
  const tab = tabKey(e.unit);
  const f = file(dir, tab);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: VERSION, tab, ...e }));
  renameSync(tmp, f);
}

export function dropEntry(dir: string, tab: string) {
  rmSync(file(dir, tab), { force: true });
}

/** Keys of timing fields in the sweep's answer: how long it took, not what it found. */
const TIMING = /^(ms|[a-z]+Ms)$/;
function dropTimings(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(dropTimings);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).filter(([k]) => !TIMING.test(k)).map(([k, v]) => [k, dropTimings(v)]));
  return x;
}

/**
 * Asks the server again for what a page asked, and digests the answer: its status, type,
 * where a redirect sends it, and its body, with the data stamp, the build's id (`stamps`:
 * whatever the run's answers carry that isn't what they say) and this server's own address
 * read past. Each request is asked once per run.
 */
export class Replayer {
  private memo = new Map<string, Promise<string>>();
  private running = 0;
  private waiting: (() => void)[] = [];
  asked = 0;
  private base: string;
  private stamps: string[];
  private limit: number;
  constructor(base: string, stamps: string[], limit = 8) {
    this.base = base;
    this.stamps = stamps;
    this.limit = limit;
  }

  digest(a: Asked): Promise<string> {
    const k = JSON.stringify(a);
    let p = this.memo.get(k);
    if (!p) {
      p = this.run(a);
      this.memo.set(k, p);
    }
    return p;
  }

  private async run(a: Asked): Promise<string> {
    while (this.running >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    this.asked++;
    const t0 = Date.now();
    const kind = a.method === "POST" ? "proofs" : a.url.startsWith("/_next/") ? "scripts" : a.url.startsWith("/api/") ? "reports" : "pages";
    try {
      const headers: Record<string, string> = { ...a.headers };
      if (process.env.API_SECRET && a.url.startsWith("/api/")) headers["x-api-secret"] = process.env.API_SECRET;
      const r = await fetch(this.base + a.url, { method: a.method, headers, body: a.body, redirect: "manual" });
      const bytes = Buffer.from(await r.arrayBuffer());
      const type = r.headers.get("content-type") ?? "";
      let body: string | Buffer = bytes;
      if (/json|text|javascript|html|x-component/.test(type)) {
        let t = bytes.toString("utf8");
        const origin = new URL(this.base);
        t = t.split(origin.origin).join("~origin~").split(origin.host).join("~host~");
        for (const s of this.stamps) if (s) t = t.split(s).join("~stamp~");
        // Next's id for this one request, the React key of the head's viewport ("…v") and metadata ("…m") boundaries: new on every answer, drawn nowhere.
        for (const m of t.matchAll(/\\?"\$L[0-9a-z]+\\?",\\?"([A-Za-z0-9_-]{21})v\\?"/g)) if (t.includes(`${m[1]}m`)) t = t.split(m[1]!).join("~request~");
        if (a.url.split("?")[0] === "/api/proof/sweep" && /json/.test(type)) {
          try {
            t = JSON.stringify(dropTimings(JSON.parse(t)));
          } catch {
            /* not JSON after all: digested as text */
          }
        }
        body = t;
      }
      const where = (r.headers.get("location") ?? "").split(new URL(this.base).origin).join("~origin~");
      return sha(`${r.status}\n${type}\n${where}\n`) + sha(body);
    } catch (e) {
      // An answer that couldn't be had matches nothing: the tab is drawn again.
      return `unanswered:${(e as Error).message}:${Math.random()}`;
    } finally {
      this.spent[kind] = (this.spent[kind] ?? 0) + Date.now() - t0;
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Time spent waiting on each kind of answer (they overlap, so the sum exceeds the wall time): where the check's time goes. */
  spent: Record<string, number> = {};
  spentText(): string {
    return Object.entries(this.spent)
      .sort((a, b) => b[1] - a[1])
      .map(([k, ms]) => `${k} ${(ms / 1000).toFixed(1)} s`)
      .join(", ");
  }

  /** Digests of every request a unit made, in order. */
  async answers(asked: Asked[]): Promise<[Asked, string][]> {
    return Promise.all(asked.map(async (a) => [a, await this.digest(a)] as [Asked, string]));
  }

  /** Whether every answer a kept entry was drawn from is the same now. */
  async unchanged(e: Entry): Promise<boolean> {
    const now = await Promise.all(e.answers.map(([a]) => this.digest(a)));
    return now.every((d, i) => d === e.answers[i]![1]);
  }
}
