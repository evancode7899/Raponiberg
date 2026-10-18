import { exceptionMatches } from "../exceptions.ts";
import {
  CHECKS,
  type AcceptedFinding,
  type CheckId,
  type CheckPass,
  type CheckResult,
  type Finding,
  type Inference,
  type IntegrityReport,
  type PassEvidence,
  type StandingException,
} from "../types.ts";

type Tally = { passed: number; failed: number; missing: number; awaiting: number; inferred: number; accepted: number };

/** The first day a finding is about: its own date, else the earliest window it blocks. */
export const findingStart = (f: Finding) => f.date ?? [f.scope, ...(f.extraScopes ?? [])].map((s) => s.from).sort()[0]!;

/** Tallies each check's outcomes while the checks run. */
export class Collector {
  private counts = new Map<CheckId, Tally>();
  findings: Finding[] = [];
  inferences: Inference[] = [];
  accepted: AcceptedFinding[] = [];
  /** Kept off the report (`report()`): the Statements page's payload doesn't carry them. */
  passes: CheckPass[] = [];

  private exceptions: StandingException[];
  private matched = new Set<string>();
  private edge: string | null;

  /** `edge`: the data edge (see Finding.atEdge); findings that start after it are marked. */
  constructor(exceptions: StandingException[] = [], edge: string | null = null) {
    this.exceptions = exceptions;
    this.edge = edge;
  }

  private tally(id: CheckId) {
    let c = this.counts.get(id);
    if (!c) this.counts.set(id, (c = { passed: 0, failed: 0, missing: 0, awaiting: 0, inferred: 0, accepted: 0 }));
    return c;
  }
  /** Records `n` passes of a check, with what they covered (see CheckPass). */
  pass(id: CheckId, ev: PassEvidence, n = 1) {
    this.tally(id).passed += n;
    const { subject, ...scope } = ev;
    this.passes.push({ check: id, n, subject, scope });
  }
  add(f: Finding) {
    if (this.findings.some((x) => x.id === f.id) || this.accepted.some((x) => x.id === f.id)) return;
    const ex = this.exceptions.find((e) => exceptionMatches(e, f));
    if (ex) {
      this.matched.add(ex.id);
      this.accepted.push({ ...f, exceptionId: ex.id, note: ex.note, acceptedAt: ex.acceptedAt });
      this.tally(f.check).accepted++;
      return;
    }
    const atEdge = !!this.edge && findingStart(f) > this.edge;
    this.findings.push(atEdge ? { ...f, atEdge: true } : f);
    // Past the data edge it's a statement still on its way, not a check that fails.
    if (atEdge) this.tally(f.check).awaiting++;
    else if (f.status === "FAIL") this.tally(f.check).failed++;
    else this.tally(f.check).missing++;
  }
  infer(i: Inference) {
    this.inferences.push(i);
    this.tally(i.check).inferred++;
  }
  report(): IntegrityReport {
    const checks: CheckResult[] = CHECKS.map((d) => ({ ...d, ...(this.counts.get(d.id) ?? { passed: 0, failed: 0, missing: 0, awaiting: 0, inferred: 0, accepted: 0 }) }));
    const order = (f: Finding) => (f.status === "FAIL" ? 0 : 1);
    return {
      checks,
      findings: [...this.findings].sort((a, b) => order(a) - order(b) || a.scope.from.localeCompare(b.scope.from)),
      inferences: this.inferences,
      accepted: this.accepted,
      // Exceptions no finding matched this run: kept, and explained by runChecks.
      stale: this.exceptions.filter((e) => !this.matched.has(e.id)).map((e) => ({ ...e, evidence: [] })),
      retired: [],
    };
  }
}
