import { spawn } from "node:child_process";
import path from "node:path";
import { dataStamp } from "../cache.ts";
import { keepSweep, restoreSweep } from "./sweepStore.ts";

/**
 * The proof sweep (sweep.ts) runs in a process of its own (scripts/proof-sweep.ts --child),
 * never in the server: it opens every figure's proof, half a minute of work on a full
 * ledger, and run inside the server it held up every page's requests for as long. In its
 * own process it runs on another core at low priority, and the server only waits for its
 * answer.
 *
 * One sweep at a time, for the data as it is (dataStamp). When the data changes while one
 * runs, it's stopped at once (its answer would describe data that's gone) and whoever was
 * waiting gets the sweep of the data as it is now. The last finished answer is kept until
 * the data changes, and on disk for the next launch (sweepStore.ts): reopened with nothing
 * changed, the app answers at once.
 */

/** A sweep under way: its answer (JSON text), and how to stop it. */
export type SweepJob = { result: Promise<string>; stop: () => void };

/** Where the sweep of the data as it is now stands, without waiting for it. */
export type SweepPeek = { state: "ready"; body: string } | { state: "pending" } | { state: "failed"; error: string };

export type SweepRunner = {
  /** The sweep of the data as it is now, as JSON text: the kept answer, the one under way, or a new one. */
  report: () => Promise<string>;
  /** The kept answer for the data as it is now, or that it's under way (started if it wasn't), or why it failed. */
  peek: () => SweepPeek;
  /** Starts the sweep of the data as it is now, if it isn't already done or under way. */
  warm: () => void;
};

/** The data changed while a sweep ran: it was stopped, and the caller asks again. */
class Superseded extends Error {}

/** How many times a caller waits out a sweep the data overtook before giving up for now. */
const MAX_RESTARTS = 5;

export function createSweepRunner(opts: {
  stamp: () => string;
  run: (stamp: string) => SweepJob;
  pollMs?: number;
  /** A kept answer for this data, from an earlier launch. */
  restore?: (stamp: string) => string | null;
  /** Keeps a finished answer for a later launch. */
  keep?: (stamp: string, body: string) => void;
}): SweepRunner {
  const { stamp, run, pollMs = 1000, restore, keep } = opts;
  // The stamps already looked up on disk, so a page asking again doesn't read it again.
  const looked = new Set<string>();
  let done: { stamp: string; body: string } | null = null;
  let current: { stamp: string; result: Promise<string> } | null = null;
  // The last sweep that failed outright (not overtaken), so a page hears why rather than waiting forever.
  let failed: { stamp: string; error: string } | null = null;

  const start = (s: string) => {
    const job = run(s);
    let timer: ReturnType<typeof setInterval> | undefined;
    const overtaken = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        if (stamp() === s) return;
        job.stop();
        reject(new Superseded());
      }, pollMs);
      timer.unref?.();
    });
    const entry = {
      stamp: s,
      result: Promise.race([job.result, overtaken]).finally(() => {
        clearInterval(timer);
        if (current === entry) current = null;
      }),
    };
    entry.result.then(
      (body) => {
        if (stamp() !== s) return;
        done = { stamp: s, body };
        keep?.(s, body);
      },
      (e) => {
        if (!(e instanceof Superseded) && stamp() === s) failed = { stamp: s, error: e instanceof Error ? e.message : String(e) };
      },
    );
    if (failed?.stamp === s) failed = null;
    current = entry;
    return entry.result;
  };

  const forNow = (): Promise<string> => {
    const s = stamp();
    if (done?.stamp === s) return Promise.resolve(done.body);
    if (current?.stamp === s) return current.result;
    if (restore && !looked.has(s)) {
      looked.add(s);
      const kept = restore(s);
      if (kept != null) {
        done = { stamp: s, body: kept };
        return Promise.resolve(kept);
      }
    }
    return start(s);
  };

  return {
    async report() {
      for (let i = 0; ; i++) {
        try {
          return await forNow();
        } catch (e) {
          if (!(e instanceof Superseded) || i >= MAX_RESTARTS) throw e instanceof Superseded ? new Error("The data kept changing while the proof sweep ran; it runs again once the data settles.") : e;
        }
      }
    },
    peek() {
      const s = stamp();
      if (done?.stamp === s) return { state: "ready", body: done.body };
      if (failed?.stamp === s && current?.stamp !== s) {
        const error = failed.error;
        // Asked again later, it tries again: a failure is never kept as the answer.
        failed = null;
        return { state: "failed", error };
      }
      void forNow().catch(() => {});
      // A sweep kept from the last launch answers at once.
      if (done?.stamp === s) return { state: "ready", body: done.body };
      return { state: "pending" };
    },
    warm() {
      void forNow().catch(() => {});
    },
  };
}

/** Runs scripts/proof-sweep.ts --child on the server's own data, environment and folder; its answer arrives over IPC. */
function runChild(): SweepJob {
  const child = spawn(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", path.join(process.cwd(), "scripts", "proof-sweep.ts"), "--child"],
    { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (b: Buffer) => (stderr = (stderr + b.toString()).slice(-2000)));
  const result = new Promise<string>((resolve, reject) => {
    let body: string | null = null;
    child.on("message", (m) => (body = typeof m === "string" ? m : JSON.stringify(m)));
    child.on("error", reject);
    child.on("exit", (code) => (body != null ? resolve(body) : reject(new Error(`The proof sweep stopped (exit ${code}): ${stderr.trim().split("\n").at(-1) ?? ""}`))));
  });
  return { result, stop: () => void child.kill() };
}

// On globalThis: each route is bundled separately, and they must share one sweep.
const g = globalThis as unknown as { __pfSweep?: SweepRunner };

/** The server's one sweep runner. */
export const proofSweep = (): SweepRunner => (g.__pfSweep ??= createSweepRunner({ stamp: () => dataStamp(), run: () => runChild(), restore: restoreSweep, keep: keepSweep }));
