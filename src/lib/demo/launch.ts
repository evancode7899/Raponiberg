import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";

/**
 * The real app's side of the demo: typing "demo" on the lock screen starts the demo
 * instance (scripts/demo.ts, its own process, port and data) if it isn't running, and the
 * lock screen sends the browser there. The real server never serves demo data itself.
 */

/** What to type on the lock screen. */
export const DEMO_WORD = "demo";

export const isDemoWord = (attempt: unknown) => typeof attempt === "string" && attempt.trim().toLowerCase() === DEMO_WORD;

export function demoUrl(): string {
  return `http://127.0.0.1:${process.env.DEMO_PORT?.trim() || "3001"}`;
}

/** The demo instance answers on its port (and is the demo, not something else there). */
async function demoIsUp(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/app-password`, { signal: AbortSignal.timeout(3000) });
    const body = (await r.json()) as { demo?: boolean };
    return body.demo === true;
  } catch {
    return false;
  }
}

const g = globalThis as unknown as { __pfDemoStart?: Promise<void> | null };

/**
 * The demo's address, once it answers. Starts it when needed: one start at a time, its
 * output in data/logs/demo.log. `exitUrl` is where the demo's "Exit demo" button leads
 * (this app).
 */
export async function ensureDemoRunning(exitUrl: string): Promise<string> {
  const url = demoUrl();
  if (await demoIsUp(url)) return url;
  g.__pfDemoStart ??= start(url, exitUrl).finally(() => {
    g.__pfDemoStart = null;
  });
  await g.__pfDemoStart;
  return url;
}

async function start(url: string, exitUrl: string) {
  const logs = path.join(dataDir(), "logs");
  mkdirSync(logs, { recursive: true });
  const log = openSync(path.join(logs, "demo.log"), "w");
  const args = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(process.cwd(), "scripts", "demo.ts")];
  if (process.env.NODE_ENV === "development") args.push("--dev");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, DEMO_EXIT_URL: exitUrl },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  let exited = false;
  child.on("exit", () => (exited = true));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await demoIsUp(url)) return;
    if (exited) throw new Error("The demo stopped while starting (see data/logs/demo.log).");
  }
  throw new Error("The demo didn't start within 3 minutes (see data/logs/demo.log).");
}

/** Asks a running demo to shut down (the real app is stopping); does nothing when it isn't running. */
export async function stopDemo(): Promise<void> {
  const url = demoUrl();
  if (!(await demoIsUp(url))) return;
  const headers = process.env.API_SECRET ? { "x-api-secret": process.env.API_SECRET } : undefined;
  await fetch(`${url}/api/system/shutdown`, { method: "POST", headers, signal: AbortSignal.timeout(3000) }).catch(() => {});
}
