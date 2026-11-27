import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Whether the checkout at `root` uses another folder's Prisma client: a worktree whose
 * node_modules is a junction to the main checkout's, or that has none of its own and
 * resolves upward to it. `prisma generate` there would point the shared client at this
 * checkout's prisma/ folder, and the running app would then open (and create) an empty
 * database in it.
 */
export function prismaClientIsShared(root: string): boolean {
  const client = path.join("node_modules", "@prisma", "client");
  try {
    return path.relative(path.join(realpathSync.native(root), client), realpathSync.native(path.join(root, client))) !== "";
  } catch {
    return true;
  }
}
