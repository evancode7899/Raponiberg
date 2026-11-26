import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpointTimings, timingTable } from "../../scripts/endpoint-timings.ts";
import { WARM_LAST, WARM_REPORTS, WARM_UPKEEP_REPORTS } from "./warmList";

let server: Server;
let base: string;
let asked = 0;
beforeAll(async () => {
  // A made-up server: the first answer to each path is slow (the report being built), the second quick.
  const seen = new Set<string>();
  server = createServer((req, res) => {
    asked++;
    const first = !seen.has(req.url!);
    seen.add(req.url!);
    setTimeout(() => res.writeHead(req.url === "/api/missing" ? 404 : 200, { "content-type": "application/json" }).end(JSON.stringify({ x: "y".repeat(2000) })), first ? 60 : 0);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("the warm list and its timings", () => {
  it("lists each report once, the slow one last", () => {
    const all = [...WARM_REPORTS, ...WARM_UPKEEP_REPORTS, ...WARM_LAST];
    expect(new Set(all).size).toBe(all.length);
    expect(all.at(-1)).toBe(WARM_LAST.at(-1));
    for (const p of all) expect(p).toMatch(/^\/api\//);
  });

  it("asks each endpoint twice, slowest first answer first, with its size and status", async () => {
    const t = await endpointTimings(base, ["/api/a", "/api/missing"]);
    expect(asked).toBe(4);
    expect(t.map((x) => x.status).sort()).toEqual([200, 404]);
    for (const x of t) {
      expect(x.firstMs).toBeGreaterThanOrEqual(50);
      expect(x.cachedMs).toBeLessThan(x.firstMs);
      expect(x.kb).toBeCloseTo(2, 0);
    }
    expect(timingTable(t)).toMatch(/^Endpoint timings/);
  });
});
