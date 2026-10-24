/**
 * Makes a copy of this repository with no history, ready to push to a brand-new GitHub
 * repository (SETUP.md › Publishing a fresh copy):
 *   1. checks this repository is in a state worth publishing (see refusal())
 *   2. runs npm run privacy:check here, and stops on any hit
 *   3. writes the committed files of HEAD into an empty folder (no data/, .env, .claude/
 *      or history: only what git tracks)
 *   4. runs npm run privacy:check -- --dir on that copy, and stops on any hit
 *   5. starts a new git repository there with a single commit
 *
 * Usage: npm run publish:export -- <empty folder outside this repository>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (args: string[], env?: Record<string, string>) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } }).trim();
const lines = (s: string) => s.split("\n").filter(Boolean);
const fail = (message: string): never => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

/** What the export can't see: it copies the committed files of HEAD, nothing else. */
type RepoState = {
  /** The checked-out branch ("HEAD" when detached). */
  branch: string;
  /** Tracked files with edits not yet committed. The export leaves these edits out. */
  uncommitted: string[];
  /** New files git would pick up (not ignored) that aren't committed. Also left out. */
  untracked: string[];
  /** Commits on this branch that aren't on its upstream yet (0 when there's no upstream). */
  unpushed: number;
};

/**
 * Why this repository shouldn't be exported as it stands, or null to go ahead. The
 * message is shown as is, so it should say what to do about it.
 */
function refusal(s: RepoState): string | null {
  const some = (files: string[]) => files.slice(0, 3).join(", ") + (files.length > 3 ? ", …" : "");
  if (s.branch !== "main") return `On "${s.branch}": publish from main (git checkout main, then git pull).`;
  if (s.uncommitted.length) return `Uncommitted edits would be left out of the copy (${some(s.uncommitted)}): commit or discard them first.`;
  if (s.untracked.length) return `New files aren't committed (${some(s.untracked)}): commit them, or add them to .gitignore if they're private.`;
  if (s.unpushed) return `${s.unpushed} commit(s) on main aren't on GitHub yet: publish only what's been merged there (git push, or a pull request).`;
  return null;
}

// ---- the target folder: new or empty, and outside this repository
const target = process.argv[2] ? path.resolve(process.argv[2]) : fail("Usage: npm run publish:export -- <empty folder>, for example C:\\dev\\raponiberg-public");
if (target === ROOT || target.startsWith(ROOT + path.sep)) fail("Export to a folder outside this repository.");
if (existsSync(target) && readdirSync(target).length) fail(`${target} isn't empty.`);

const state: RepoState = {
  branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
  uncommitted: lines(git(["diff", "--name-only", "HEAD"])),
  untracked: lines(git(["ls-files", "--others", "--exclude-standard"])),
  unpushed: (() => {
    try {
      return Number(git(["rev-list", "--count", "@{upstream}..HEAD"]));
    } catch {
      return 0;
    }
  })(),
};
const why = refusal(state);
if (why) fail(why);

// One command string: Node deprecates separate args with shell: true (DEP0190). The only
// argument with spaces in it, the target folder, is quoted where it's added.
const npm = (args: string[]) => spawnSync(["npm", ...args].join(" "), { cwd: ROOT, stdio: "inherit", shell: true }).status === 0;
console.log("Checking this repository for personal data…");
if (!npm(["run", "privacy:check"])) fail("Make the code generic where it's flagged above, commit, and export again.");
console.log("Checking the license safeguards…");
if (!npm(["run", "license:check"])) fail("Restore the license safeguards flagged above (npm run license:restore), commit, and export again.");

// ---- copy HEAD's files through a throwaway index, so this repository's own index and
// working tree are never touched
mkdirSync(target, { recursive: true });
const index = path.join(os.tmpdir(), `raponiberg-export-${process.pid}.index`);
try {
  git(["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
  git(["checkout-index", "--all", `--prefix=${target}${path.sep}`], { GIT_INDEX_FILE: index });
} finally {
  rmSync(index, { force: true });
}

console.log(`\nChecking the exported copy in ${target}…`);
if (!npm(["run", "privacy:check", "--", "--dir", `"${target}"`])) fail(`The copy has personal data. Delete ${target}, fix what's flagged, and export again.`);
if (!npm(["run", "license:check", "--", "--dir", `"${target}"`])) fail(`The copy's license safeguards failed. Delete ${target}, fix what's flagged, and export again.`);

const inTarget = (args: string[]) => execFileSync("git", args, { cwd: target, stdio: "inherit" });
inTarget(["init", "--quiet", "--initial-branch=main"]);
inTarget(["add", "--all"]);
inTarget(["commit", "--quiet", "--message", "Raponiberg"]);

console.log(`
Exported ${git(["ls-files"]).split("\n").length} files with one commit to ${target}.

Next (SETUP.md › Publishing a fresh copy):
  1. On GitHub, create a new PRIVATE repository with nothing in it.
  2. cd "${target}"
     git remote add origin <the new repository's address>
     git push -u origin main
  3. Look it over on GitHub, then share it.`);
