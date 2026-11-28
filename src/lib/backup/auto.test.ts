import { beforeEach, describe, expect, it, vi } from "vitest";

const created = vi.fn();
const writeDigest = vi.fn();
const stale = vi.fn();
const dir = vi.fn();

vi.mock("./backup.ts", () => ({ backupRoot: () => ({ root: "/backups", source: "BACKUP_DIR" }), listSnapshots: () => [], createBackup: () => created() }));
vi.mock("../digest/write.ts", () => ({ DIGEST_FILE_NAME: "raponiberg-digest.html", digestDir: () => dir(), digestStale: (_f: string, c: boolean) => stale(c), writeDigest: (...a: unknown[]) => writeDigest(...a) }));
vi.mock("../book/cache.ts", () => ({ getBook: async () => ({ book: true }) }));

const { runBackup } = await import("./auto");
const db = { $executeRawUnsafe: async () => 0, $queryRawUnsafe: async () => [] };

describe("runBackup refreshes the phone digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dir.mockReturnValue("/phone");
    writeDigest.mockResolvedValue({ file: "/phone/raponiberg-digest.html", bytes: 1, asOf: "2026-03-31" });
  });

  it("after a backup that saved something new", async () => {
    created.mockResolvedValue({ status: "created" });
    stale.mockImplementation((c: boolean) => c);
    await runBackup(db, "shutdown");
    expect(stale).toHaveBeenCalledWith(true);
    expect(writeDigest).toHaveBeenCalledWith(db, { book: true }, "/phone");
  });

  it("not when nothing changed and today's digest is there", async () => {
    created.mockResolvedValue({ status: "unchanged" });
    stale.mockReturnValue(false);
    await runBackup(db, "auto");
    expect(writeDigest).not.toHaveBeenCalled();
  });

  it("not without DIGEST_DIR, and a failing digest never fails the backup", async () => {
    created.mockResolvedValue({ status: "created" });
    dir.mockReturnValue(null);
    await runBackup(db, "auto");
    expect(writeDigest).not.toHaveBeenCalled();

    dir.mockReturnValue("/phone");
    stale.mockReturnValue(true);
    writeDigest.mockRejectedValue(new Error("disk full"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runBackup(db, "manual")).resolves.toEqual({ status: "created" });
    expect(err).toHaveBeenCalledWith("[digest]", "disk full");
  });
});
