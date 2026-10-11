import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Lines of code in this app, for the note in Settings › General. Counts the files git
 * tracks (so node_modules, build folders and data/ never count) with a code extension; JSON,
 * Markdown and the lockfile are left out. Cheap: ~400 files, well under a second.
 */

const run = promisify(execFile);

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".prisma", ".sql", ".ps1", ".vbs", ".bat", ".cmd", ".sh"]);

export function isCodeFile(file: string): boolean {
  return CODE_EXT.has(path.posix.extname(file.replace(/\\/g, "/")).toLowerCase());
}

/** Line count the way git and `wc -l` see it: a final line without a newline still counts. */
export function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

export async function codeLineCount(root = process.cwd()): Promise<number> {
  const { stdout } = await run("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const counts = await Promise.all(
    stdout
      .split("\0")
      .filter((f) => f && isCodeFile(f))
      .map((f) =>
        readFile(path.join(root, f), "utf8")
          .then(countLines)
          .catch(() => 0), // tracked but deleted in the working tree
      ),
  );
  return counts.reduce((s, n) => s + n, 0);
}
