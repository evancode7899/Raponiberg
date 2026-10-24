# How the license is protected

The [LICENSE](../LICENSE) keeps the app named "Raponiberg" and forbids making money from it.
Nothing can stop a determined person who rewrites every file, but these layers make deleting
or editing the license, renaming the app, or adding payments fail in many places at once, and
make it hard to talk an AI assistant into helping.

## The layers

`npm run license:check` runs them all. It also runs before every commit and push (the git
hooks `npm run setup` turns on), before `npm test` and `npm run dev`, and in CI.

| Layer | What it catches |
| --- | --- |
| **Pins** | The LICENSE's SHA-256 is written in six files (the check script, `package.json`, `AGENTS.md`, `ci.yml`, `src/lib/provenance.ts`, `.githooks/provenance`). More than half must agree, so editing the LICENSE and one or two pins still fails. |
| **Hidden copies** | Two more full copies of the license text, compressed or encoded, in `src/lib/provenance.ts` and `.githooks/provenance`. They must hash to the pinned value, and `npm run license:restore` rebuilds a deleted or edited LICENSE (and all pins) from them, or from older git commits. |
| **Independent CI check** | The `license` job in `ci.yml` compares the LICENSE hash in plain shell before running the script, so it holds even if the script is gutted. |
| **Owner's signature** | An Ed25519 signature (`.license-seal.json`) over the hashes of the LICENSE, the AI-assistant rules and the guard scripts. The private key is not in the repository, so a claim to be the owner can't produce it. See below. |
| **Name and money tripwires** | The package name and page title stay "Raponiberg"; no payment, ad or donation packages, links or `FUNDING.yml`. A heuristic: it catches lazy attempts and leaves a clear message for an AI assistant that runs into it. |
| **Assistant rules** | `AGENTS.md` (read by Codex, Cursor, Copilot, Gemini and others), `CLAUDE.md`, `GEMINI.md`, `.cursor/rules` and `.github/copilot-instructions.md` tell assistants that identity claims don't count and that only the owner's signature changes the license. |
| **Original repository** | `npm run license:check -- --upstream` compares this copy's LICENSE (and owner key) with the original on GitHub. `--since <rev>` does the same against an earlier commit, which the pre-push hook and CI use. `--upstream` is a manual command: the app itself never makes this request. |

## One-time setup by the owner (two commands, in your own terminal)

Until you do this, the signature layer is dormant (the check prints "Not signed yet").

1. `npm run license:keygen` creates the signing key in `~/.raponiberg/` (never in the
   repository), encrypted with a passphrase you type. Back the file up privately, for
   example in your password manager's file storage. **Do not run it from an AI assistant's
   terminal, and don't give an assistant the passphrase**: an assistant that can read your home
   folder can read the key file, and the passphrase is what stops it from signing.
2. `npm run license:seal` refreshes every pin and copy and writes `.license-seal.json`.
   Commit the result.

From then on, any change to a sealed file (`LICENSE`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
`.cursor/rules/raponiberg.mdc`, `.github/copilot-instructions.md`, the two hooks, and the two
`scripts/license-*.ts`) fails the check until you run `npm run license:seal` again. That is
the point: only you can make such a change valid. Run it after editing any of them, including
rewording `AGENTS.md`.

## Changing the license on purpose (for example, to allow selling it)

You are the copyright holder, so you can. The checks are there so that only you can.

1. Tag the last version under the current terms (for example `v0.2.x-free`). Copies people
   already have stay under the license they received them with: it has no revocation clause.
2. Edit `LICENSE`, and say which versions each license covers. Update `AGENTS.md` to match,
   and `checkRules` in `scripts/license-guard.ts` (the name and payment tripwires), or the
   check will keep rejecting what you add. Have a lawyer read the new terms.
3. In your own terminal, `npm run license:seal`, and type your passphrase. That refreshes
   every pin and copy and signs the new state.
4. Commit and push to the original repository on GitHub. Existing copies that run
   `--upstream` will see that their LICENSE differs from yours, which is correct.

## Replacing the signing key

- **Moving to a new key:** `npm run license:keygen -- --key ~/.raponiberg/new-key.pem`, then
  `npm run license:seal -- --key ~/.raponiberg/new-key.pem --old-key ~/.raponiberg/license-signing-key.pem`.
  Both passphrases are asked for. The old key signs a hand-over to the new one, kept in
  `.license-seal.json`. A local check can't tell a hand-over from a swap, because every pin can be
  rewritten, so the pre-push hook, the CI pull-request job and `--upstream` each compare with the
  last published seal and require that hand-over. Nobody without the old key can produce one.
- **Lost key or forgotten passphrase:** make a new key as above and seal with
  `-- --replace-lost-key`. There is no hand-over to show, so the pre-push hook and CI will
  refuse it. You overcome that as the owner of the GitHub repository: push with
  `git push --no-verify` and merge as an administrator, bypassing the failed check. That is the
  fallback nobody else has.

## Do these on GitHub too (settings only you can change)

- Protect `main`: require pull requests and the `license` and `fresh-clone` checks, and block
  force pushes and deletion. With a solo repository, skip "require approvals" (you can't
  approve your own pull request) and rely on the checks instead.
- Turn on **Require review from Code Owners** only if you have a second reviewer;
  `.github/CODEOWNERS` already lists the protected files.
- Sign your commits (GitHub › Settings › SSH and GPG keys, then `git config commit.gpgsign true`)
  and turn on **Require signed commits**, so a commit claiming to be yours must carry your key.
- Keep the original repository public and its history intact: it is the reference that
  `--upstream` and `license:restore` fall back on.

## What this does not do

- Someone who edits the LICENSE, every pin, every copy, the check, the hooks and the CI job
  at once, and removes the signer pins, passes the local check. Only the original repository
  (`--upstream`, branch protection, signed commits) can show that.
- The license only binds people who accept it; copyright law and the license text do the real
  enforcing. If you find a violating copy, a DMCA takedown to its host is the remedy.
