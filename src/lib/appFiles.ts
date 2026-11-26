/**
 * Files the app keeps for itself in the data folder that no figure reads: saved views and
 * pins, the restore drill's last result, the audit chain's newest link, the restatement log. They are left out of the Book's stamp
 * (book/cache.ts), so saving one never rebuilds the Book or re-runs the proof sweep, and the
 * backup copies them with every other top-level file (lib/backup/backup.ts).
 */
export const APP_FILES: ReadonlySet<string> = new Set(["pins.json", "restore-drill.json", "audit-head.json", "restatements.json"]);
