# Setup on Windows, with statements and backups in OneDrive

The app lives in **`C:\dev\personal-finance`**, outside OneDrive: OneDrive turns build files into
cloud placeholders and breaks `next build`. The statements and the backups stay in OneDrive:

| Folder | What | Set by |
|--------|------|--------|
| `C:\dev\personal-finance` | the app (this Git repo) | — |
| `OneDrive\Desktop\Personal Finance\3. Statements` | statement PDFs, one subfolder per institution | `STATEMENTS_DIR` in `.env` |
| `OneDrive\Desktop\Tax` | filed tax returns, W-2s, 1099s, K-1s, one subfolder per year | `TAX_DOCS_DIR` in `.env` |
| `OneDrive\Desktop\Personal Finance\2. Web App Backup` | automatic backups of `data/` | `BACKUP_DIR` in `.env` |

## 1. Prerequisites

- **Node.js** (LTS, 22.18 or newer) and **Git for Windows**, both on your PATH. Check with
  `node --version` and `git --version` in a new PowerShell window. If either isn't found, add
  `C:\Program Files\nodejs` or `C:\Program Files\Git\cmd` to your user **Path**
  (Win → "environment variables" → Path → Edit → New), then open a new terminal.
- Git identity, once per PC (the email you use on GitHub):

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

- **OneDrive** signed in, with `Desktop\Personal Finance` synced.

## 2. New or wiped computer

```powershell
git clone <this repository's address> C:\dev\personal-finance
cd C:\dev\personal-finance
npm install
npm run setup
```

`npm run setup`:

1. creates `.env` from `.env.example` if it's missing;
2. restores the newest snapshot from `2. Web App Backup` (the database, every decision file in
   `data/`, and the stored statement PDFs) and sets `BACKUP_DIR` / `STATEMENTS_DIR` in `.env`;
3. brings the database up to the current schema (`npm run db:refresh`);
4. turns on the privacy check before every `git push` (`.githooks/pre-push`);
5. creates the **Raponiberg** shortcut on the Desktop.

Then double-click **Raponiberg**. Optional: `npm run logon:register` starts it at Windows sign-in.

If OneDrive is still downloading the backup, the restore stops and says so; wait and run
`npm run setup` again. If the backup folder is somewhere else:
`npm run setup -- --from "D:\path\to\2. Web App Backup"`.

## 3. Backups

While the desktop app runs it backs up every 15 minutes, only when something changed, and again
when you close it with the power button; a launch that pulls new code backs up before migrating.
**Settings › Data › Cloud backup** shows the latest snapshot and has **Back up now**.

```
2. Web App Backup\
  README.txt               restore steps
  snapshots\<date_time>\   finance.db + every file from data\ + manifest.json (hashes)
  statements\              data\statements, mirrored once (PDFs never change)
```

Kept: the newest 10 snapshots, one a day for 45 days, then one a month.

| Task | Command |
|------|---------|
| Back up now | `npm run backup` |
| List snapshots | `npm run restore -- --list` |
| Restore the newest (close the app with its power button first) | `npm run restore` |
| Restore a specific snapshot | `npm run restore -- 2026-10-09_22-15-03` |

A restore copies the current data to `data\backups\pre-restore_<time>\` before replacing it, checks
the snapshot's hashes and `PRAGMA integrity_check`, then runs `npm run db:refresh`.

`npm run db:backup` is a separate local copy of just `finance.db` into `data\backups\` (handy
before risky schema work; `npm run db:migrate:safe` does it automatically).

## 4. Updating

Close the app with the **power button** in its top bar, then open **Raponiberg** again. Every
start (when the server isn't already running) fetches from GitHub and fast-forwards to the
version this copy follows. It backs up if new code arrived, then reinstalls dependencies,
migrates and rebuilds only what changed. Offline, or an update that can't fast-forward, just
starts the version already there; `data\logs\launcher.log` and `update.err.log` say why. If
the app ever won't load, `npm run app:stop` stops the server.

Which version a copy follows is `UPDATE_CHANNEL` in `.env`:

- `release` (the default, for everyone else): the newest release tag.
- `main` (the maintainer's copy): every merged change, without waiting for a release.
  **On a new computer, add `UPDATE_CHANNEL="main"` to `.env` after `npm run setup`**,
  because `.env` isn't part of the backup.

A copy with commits of its own (customized) never updates itself.

## 4a. Releases

**Releases are made by hand.** Merging to `main` doesn't release anything; everyone on the
`release` channel stays where they are until you publish one. When `main` holds changes
worth giving everyone and CI is green on it, run the Release workflow
(`.github/workflows/release.yml`) from GitHub's **Actions → Release → Run workflow**, or:

```powershell
gh workflow run release.yml
```

It tags the tip of `main` with the next patch version (v0.2.0 → v0.2.1) and publishes a
GitHub release whose notes list the pull requests merged since the last one. Everyone on the
`release` channel moves to it the next time they open the app.

- **A bigger version jump** (a new feature set, a breaking change): give the version.

  ```powershell
  gh workflow run release.yml -f version=v0.3.0
  ```

- It refuses to release a commit whose CI didn't pass, one that's already released, or a
  version that isn't newer than the last.
- The release version is the git tag. `package.json`'s `"version"` isn't bumped, because a
  `package.json` change makes every launcher reinstall its dependencies.
- Tags must look like `vMAJOR.MINOR.PATCH`. The launcher ignores anything else, including
  pre-releases like `v0.3.0-rc1`.
- A release can't be quietly taken back: if one is broken, fix it on `main` and release a
  new version.

## 5. Database notes

- The ledger is one SQLite file, `data\finance.db` (gitignored). Only code and migration history
  are in Git.
- `npm run db:studio` opens Prisma Studio; Settings › Data › Database browser is a read-only view.
- `npm run db:migrate` creates a migration after editing `prisma/schema.prisma`. Never run
  `prisma migrate reset` on a database you care about.
- Health check: [http://localhost:3000/api/health/db](http://localhost:3000/api/health/db).

## 6. Optional

Turn off Next.js telemetry: `setx NEXT_TELEMETRY_DISABLED 1`, then open a new terminal.

## 7. Publishing a fresh copy

The repository's old history holds personal details that the current code doesn't. To
share the app, publish a copy with **no history**. Never make an old repository public or
add people to it: its commits, pull requests and branches keep everything ever written.

1. **Export.** Commit everything, switch to `main`, then:

   ```powershell
   npm run publish:export -- C:\dev\raponiberg-public
   ```

   This runs `npm run privacy:check` on this repo and stops on any hit. It then copies only
   the committed files (`git archive HEAD`: no `data/`, `.env`, `.claude/` or history)
   into the new folder, runs the check again on that copy, and makes a single commit there.
2. **Create the new repository** on GitHub: **New repository**, **Private** for now, and
   nothing added (no README, license or .gitignore).
3. **Push the copy:**

   ```powershell
   cd C:\dev\raponiberg-public
   git remote add origin <the new repository's address>
   git push -u origin main
   ```

4. **Look it over on GitHub.** There should be one commit, and no `data` files beyond
   `.gitkeep`. Turn on **Settings › Code security › Secret scanning** and **Push
   protection**. Then share it: add people under **Settings › Collaborators**, or make it
   public under **Settings › General › Danger Zone › Change visibility**.
5. **Move this computer onto the new repository**, so the shortcut's updates come from it
   and the old history leaves this computer:
   1. Close Raponiberg with its power button.
   2. Rename `C:\dev\personal-finance` to `C:\dev\personal-finance-old`.
   3. `git clone <the new repository's address> C:\dev\personal-finance`
   4. Copy `data\` and `.env` from the `-old` folder into the new one.
   5. In the new folder, run `npm install`, then `npm run setup`. Setup keeps the copied
      database, migrates it and remakes the shortcut.
   6. Open Raponiberg. Once everything looks right, delete `C:\dev\personal-finance-old`.
6. **Retire the old repository.** Keep it private, or delete it on GitHub under
   **Settings › General › Danger Zone**. Don't push any branch made before the move to the
   new repository: those branches carry the old history.

Before every push after that, run `npm run privacy:check`. CI can't run it, because it
needs this computer's data to know what's personal.
