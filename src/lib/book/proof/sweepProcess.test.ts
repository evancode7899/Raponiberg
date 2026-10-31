import { describe, expect, it } from "vitest";
import { createSweepRunner, type SweepJob } from "./sweepProcess";

/** A sweep the test finishes by hand, and a record of every one started and stopped. */
function fakeRuns() {
  const started: { stamp: string; finish: (body: string) => void; fail: (e: Error) => void; stopped: boolean }[] = [];
  const run = (stamp: string): SweepJob => {
    let finish!: (body: string) => void;
    let fail!: (e: Error) => void;
    const result = new Promise<string>((res, rej) => {
      finish = res;
      fail = rej;
    });
    const job = { stamp, finish, fail, stopped: false };
    started.push(job);
    return { result, stop: () => (job.stopped = true) };
  };
  return { started, run };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("the proof sweep runner", () => {
  it("runs one sweep per state of the data and keeps its answer until the data changes", async () => {
    let stamp = "a";
    const { started, run } = fakeRuns();
    const s = createSweepRunner({ stamp: () => stamp, run, pollMs: 5 });
    const one = s.report();
    const two = s.report();
    expect(started).toHaveLength(1);
    started[0]!.finish('{"n":1}');
    expect(await one).toBe('{"n":1}');
    expect(await two).toBe('{"n":1}');
    expect(await s.report()).toBe('{"n":1}');
    expect(started).toHaveLength(1);
    stamp = "b";
    const three = s.report();
    expect(started).toHaveLength(2);
    started[1]!.finish('{"n":2}');
    expect(await three).toBe('{"n":2}');
  });

  it("stops a sweep the data overtook, and hands its callers the sweep of the data as it is now", async () => {
    let stamp = "a";
    const { started, run } = fakeRuns();
    const s = createSweepRunner({ stamp: () => stamp, run, pollMs: 5 });
    const waiting = s.report();
    stamp = "b";
    await tick(20);
    expect(started[0]!.stopped).toBe(true);
    expect(started).toHaveLength(2);
    expect(started[1]!.stamp).toBe("b");
    started[1]!.finish('{"n":"b"}');
    expect(await waiting).toBe('{"n":"b"}');
  });

  it("never keeps an answer for data that changed while it was sent", async () => {
    let stamp = "a";
    const { started, run } = fakeRuns();
    const s = createSweepRunner({ stamp: () => stamp, run, pollMs: 1000 });
    const first = s.report();
    started[0]!.finish('{"n":"a"}');
    await first;
    stamp = "b";
    void s.report();
    expect(started).toHaveLength(2);
  });

  it("passes a failed sweep on, and tries again on the next ask", async () => {
    const { started, run } = fakeRuns();
    const s = createSweepRunner({ stamp: () => "a", run, pollMs: 5 });
    const one = s.report();
    started[0]!.fail(new Error("no database"));
    await expect(one).rejects.toThrow("no database");
    void s.report();
    expect(started).toHaveLength(2);
  });

  it("warms without anyone waiting, and a warm sweep answers the next ask", async () => {
    const { started, run } = fakeRuns();
    const s = createSweepRunner({ stamp: () => "a", run, pollMs: 5 });
    s.warm();
    s.warm();
    expect(started).toHaveLength(1);
    started[0]!.finish("{}");
    await tick();
    expect(await s.report()).toBe("{}");
    expect(started).toHaveLength(1);
  });

  it("peeks without waiting: pending while the sweep of the data runs, then the answer", async () => {
    let stamp = "a";
    const { started, run } = fakeRuns();
    const s = createSweepRunner({ stamp: () => stamp, run, pollMs: 5 });
    expect(s.peek()).toEqual({ state: "pending" });
    expect(s.peek()).toEqual({ state: "pending" });
    expect(started).toHaveLength(1);
    started[0]!.finish('{"n":1}');
    await tick();
    expect(s.peek()).toEqual({ state: "ready", body: '{"n":1}' });
    stamp = "b";
    expect(s.peek()).toEqual({ state: "pending" });
    expect(started).toHaveLength(2);
  });

  it("peeks a failed sweep as failed once, then tries again", async () => {
    const { started, run } = fakeRuns();
    const s = createSweepRunner({ stamp: () => "a", run, pollMs: 5 });
    s.peek();
    started[0]!.fail(new Error("The proof sweep stopped (exit 1)"));
    await tick();
    expect(s.peek()).toEqual({ state: "failed", error: "The proof sweep stopped (exit 1)" });
    expect(s.peek()).toEqual({ state: "pending" });
    expect(started).toHaveLength(2);
  });
});
