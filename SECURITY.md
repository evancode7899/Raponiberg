# Security

## What Raponiberg protects, and what it doesn't

Raponiberg is built to keep your financial data on your own computer:

- It runs a server that only your computer can reach (`127.0.0.1`). Other devices on your
  network can't open it.
- It never logs in to banks, and its code never sends your data anywhere. Its only
  network call is the desktop shortcut's update check against GitHub. (Next.js, the
  framework it's built on, sends anonymous build statistics that contain none of your
  data. Turn them off with `setx NEXT_TELEMETRY_DISABLED 1`.)
- Git ignores your data (`data/`) and settings (`.env`), and `npm run privacy:check` runs
  before every push, so neither ends up on GitHub.

It does **not**:

- **Encrypt anything.** The database, statement PDFs, decision files and backups are
  plain files. Protect them the way you protect your computer: a Windows sign-in
  password, BitLocker or FileVault disk encryption, and a backup folder you trust.
- **Have real access control.** The lock-screen password only stops someone casually
  using your open computer. It's stored in plain text, and the app's API doesn't check
  it. Anyone who can use your computer as you can read your data.

## Reporting a vulnerability

Please don't open a public issue or pull request about a security problem. Use
**Security › Report a vulnerability** on this repository's GitHub page instead. If that
isn't available, contact the maintainer through their GitHub profile. Never include
real financial data in a report.

This is a personal project with no service-level promise. Fixes ship in a new release
(see the README's "Updates").
