import { medicalReportOf } from "../../medical/book.ts";
import type { MedicalCheck } from "../../medical/report.ts";
import type { Book } from "../load.ts";
import type { CheckId, FindingStatus } from "../types.ts";
import type { Collector } from "./collector.ts";

/**
 * The health coverage documents, held to themselves and to the rest of the Book (the
 * Medical page's checks, lib/medical/report.ts, here so Statements › Checks lists them with
 * every other check): each EOB's lines add to its claims and its payment summary is its
 * claims; each plan's limits are the ones its EOBs count against; every health premium on
 * the pay stubs falls in a plan on file; and HSA money from pay falls in an HSA-eligible
 * medical plan. They withhold nothing elsewhere: the EOBs are the Medical page's own source.
 */

const KIND: { prefix: string; check: CheckId; status: FindingStatus; title: (c: MedicalCheck) => string; fix: string }[] = [
  { prefix: "medical.lines:", check: "medical.eob-lines", status: "FAIL", title: (c) => `${c.subject}: service lines don't add to the claims`, fix: "Open the EOB beside the Medical page's Documents tab: if the PDF adds up, the reader misread it (ask Claude to fix the EOB reader)." },
  { prefix: "medical.summary:", check: "medical.eob-summary", status: "FAIL", title: (c) => `${c.subject}: payment summary isn't its claims`, fix: "Compare the EOB's payment summary to its claims: if the PDF agrees with itself, the reader misread it." },
  { prefix: "medical.plan:", check: "medical.plan-limits", status: "FAIL", title: (c) => `${c.subject}: limits differ from its EOBs`, fix: "Correct the plan's deductible or out-of-pocket limit in data/medical-plans.json to what its documents and EOBs print." },
  { prefix: "medical.premiums:", check: "medical.premiums", status: "MISSING", title: (c) => `${c.subject}: a plan year isn't on file`, fix: "Save that plan year's summary of benefits in the statements folder and ask Claude to read it into data/medical-plans.json." },
  { prefix: "medical.hsa-eligible", check: "medical.hsa-eligible", status: "FAIL", title: () => "HSA money from pay without an HSA-eligible plan", fix: "Check the plan's hsaEligible in data/medical-plans.json; if it's right, the contributions are excess: withdraw them before the filing deadline (Form 8889)." },
];

export function checkMedical(book: Book, c: Collector) {
  if (!book.medical?.docs && !book.medical?.plans.length) return;
  for (const m of medicalReportOf(book).checks) {
    const k = KIND.find((x) => m.id.startsWith(x.prefix));
    if (!k) continue;
    const scope = { from: m.date, to: m.date > book.today ? m.date : book.today, affects: [] as [] };
    if (m.ok) c.pass(k.check, { subject: `${m.subject}: ${m.detail}`, ...scope });
    else c.add({ id: m.id, check: k.check, status: k.status, title: k.title(m), detail: m.detail, fix: k.fix, scope, date: m.date });
  }
}
