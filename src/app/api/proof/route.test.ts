import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// No database: the Book is never built for a request that's turned away.
const getBook = vi.fn(() => Promise.reject(new Error("the Book shouldn't be built")));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/book/cache", () => ({ dataStamp: () => "stamp", getBook }));

const { POST } = await import("./route");

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new NextRequest("http://127.0.0.1/api/proof", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers }));

describe("POST /api/proof", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("turns away a request without the API secret", async () => {
    vi.stubEnv("API_SECRET", "example-secret");
    const res = await post({ report: "cash-flow", metric: "income", granularity: "month", start: "2025-01-01", end: "2025-01-31" });
    expect(res.status).toBe(401);
    expect(getBook).not.toHaveBeenCalled();
  });

  it("rejects a bad descriptor before building anything", async () => {
    for (const body of ["not json", { report: "cash-flow", metric: "profit", granularity: "month", start: "2025-01-01", end: "2025-01-31" }, { report: "cash-flow" }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
    expect(getBook).not.toHaveBeenCalled();
  });
});
