import { createHash } from "node:crypto";

/** Content hash used to dedupe statement re-uploads regardless of filename. */
export function hashFile(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
