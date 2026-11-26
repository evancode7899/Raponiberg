import { describe, expect, it } from "vitest";
import { bytesLabel, MAX_DATABASE_UPLOAD_BYTES, MAX_REQUEST_BYTES, MAX_STATEMENT_FILE_BYTES, MAX_STATEMENT_UPLOAD_BYTES, oversizedFiles, requestTooLarge, statementUploadProblem } from "./uploadLimits";

const MB = 1024 * 1024;

describe("upload limits", () => {
  it("writes sizes the way people read them", () => {
    expect(bytesLabel(MAX_STATEMENT_FILE_BYTES)).toBe("50 MB");
    expect(bytesLabel(2048 * MB)).toBe("2 GB");
    // The proxy passes on whole any request the caps allow.
    expect(MAX_REQUEST_BYTES).toBeGreaterThanOrEqual(MAX_STATEMENT_UPLOAD_BYTES);
    expect(MAX_REQUEST_BYTES).toBeGreaterThanOrEqual(MAX_DATABASE_UPLOAD_BYTES);
    expect(bytesLabel(1.5 * MB)).toBe("1.5 MB");
    expect(bytesLabel(300)).toBe("1 KB");
  });

  it("refuses a request that says it is too big, and reads one that doesn't say", () => {
    expect(requestTooLarge(String(MAX_STATEMENT_UPLOAD_BYTES + 1), MAX_STATEMENT_UPLOAD_BYTES)).toBe(true);
    expect(requestTooLarge(String(MAX_STATEMENT_UPLOAD_BYTES), MAX_STATEMENT_UPLOAD_BYTES)).toBe(false);
    expect(requestTooLarge(null, MAX_STATEMENT_UPLOAD_BYTES)).toBe(false);
  });

  it("names each file over the cap, and a batch too big as a whole", () => {
    const ok = { name: "example-statement.pdf", size: 2 * MB };
    expect(statementUploadProblem([ok])).toBeNull();
    expect(oversizedFiles([ok, { name: "holiday.mov", size: 900 * MB }])).toEqual(["holiday.mov (900 MB)"]);
    expect(statementUploadProblem([ok, { name: "holiday.mov", size: 900 * MB }])).toMatch(/^Over the 50 MB a file may be: holiday\.mov/);
    expect(statementUploadProblem(Array.from({ length: 6 }, (_, i) => ({ name: `s${i}.pdf`, size: 45 * MB })))).toMatch(/smaller batches/);
  });
});
