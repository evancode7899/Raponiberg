import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./dataDir.ts";

/**
 * The lock screen's password: a deterrent against someone casually opening the app on an
 * unlocked laptop, not security. It is kept in plain text in data/app-password.json
 * (gitignored, backed up with the rest of data/) and the API under it is not gated by it.
 * No file, or a damaged one, means the default. Forgot it? Delete the file and the
 * password is "password" again.
 */

export const APP_PASSWORD_FILE_NAME = "app-password.json";
export const DEFAULT_APP_PASSWORD = "password";
const MAX_LENGTH = 200;

type AppPasswordFile = { version: 1; password: string; savedAt: string };

export function appPasswordFilePath(): string {
  return process.env.APP_PASSWORD_FILE || path.join(dataDir(), APP_PASSWORD_FILE_NAME);
}

export function readAppPassword(file = appPasswordFilePath()): string {
  if (!existsSync(file)) return DEFAULT_APP_PASSWORD;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AppPasswordFile>;
    return typeof parsed.password === "string" && parsed.password.length > 0 ? parsed.password : DEFAULT_APP_PASSWORD;
  } catch {
    return DEFAULT_APP_PASSWORD;
  }
}

export function isDefaultAppPassword(file = appPasswordFilePath()): boolean {
  return readAppPassword(file) === DEFAULT_APP_PASSWORD;
}

export function checkAppPassword(attempt: unknown, file = appPasswordFilePath()): boolean {
  return typeof attempt === "string" && attempt === readAppPassword(file);
}

/** Saves a new password. Throws on a blank or oversized one. */
export function writeAppPassword(password: unknown, file = appPasswordFilePath()): void {
  if (typeof password !== "string" || password.length === 0) throw new Error("Enter a password");
  if (password.length > MAX_LENGTH) throw new Error(`Keep it under ${MAX_LENGTH} characters`);
  const data: AppPasswordFile = { version: 1, password, savedAt: new Date().toISOString() };
  mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, text);
    rmSync(tmp, { force: true });
  }
}
