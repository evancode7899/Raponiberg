import type { PositionedItem } from "../statements/pdfLayout.ts";
import type { BalanceKind, Coverage, EobBalance, EobClaim, EobLine, EobPayment, EobStatement, EobTotals, PendingEob, PlanDocument } from "./types.ts";

/**
 * Reads an insurer's Explanation of Benefits from the PDF's positioned text. The claims
 * table prints its amounts under lettered columns (A billed … I your share) and leaves
 * blank cells out, so the plain text can't say which column an amount is in: each amount
 * goes to the column whose letter sits just left of its right edge (amounts are right
 * aligned 6–25pt past their letter; letters are at least 38pt apart).
 *
 * The rest (payment summary, benefit balances, remarks) reads from each printed row's text.
 * Bump MEDICAL_READER_VERSION whenever the reader changes: every EOB is read again.
 */
export const MEDICAL_READER_VERSION = 2;

/** What a PDF's plain text says it is: an EOB of some coverage, or null. */
export function eobCoverage(text: string): Coverage | null {
  if (!/Explanation of (?:Dental |Vision )?Benefits|Vision Benefit Statement/i.test(text) || !/not a bill/i.test(text)) return null;
  if (/Explanation of Dental Benefits/i.test(text)) return "DENTAL";
  if (/Vision Benefit Statement|Explanation of Vision Benefits/i.test(text)) return "VISION";
  const balance = /^(Medical|Dental|Vision) (?:In|Out of) Network /m.exec(text)?.[1];
  if (balance) return balance.toUpperCase() as Coverage;
  if (/\bdental\b/i.test(text.slice(0, 3000))) return "DENTAL";
  if (/\b(vision|eyewear)\b/i.test(text.slice(0, 3000))) return "VISION";
  return "MEDICAL";
}

const PLAN_TITLES: [RegExp, string][] = [
  [/Summary of Benefits and Coverage/i, "Summary of Benefits and Coverage"],
  [/SCHEDULE OF BENEFITS/, "Schedule of Benefits"],
  [/CERTIFICATE OF COVERAGE/i, "Certificate of Coverage"],
  [/booklet-certificate amendment|certificate amendment|rider to (?:the|your) certificate/i, "Amendment to the certificate"],
  [/Summary Plan Description/i, "Summary Plan Description"],
  [/Benefits Detail for|My Benefits/i, "Benefits summary"],
  [/HOW DOES YOUR PLAN WORK|Account Details/i, "Coverage details"],
];

/**
 * A health plan's own document (its summary of benefits, certificate, schedule, an
 * amendment): its title and coverage, or null. Its terms are read in chat into
 * data/medical-plans.json (lib/medical/plans.ts); the scan only notes that it's there.
 */
export function planDocument(text: string): PlanDocument | null {
  const head = text.slice(0, 2500);
  const title = PLAN_TITLES.find(([re]) => re.test(head))?.[1];
  if (!title || !/(insurance company|health plan|coverage|benefits)/i.test(head) || eobCoverage(text)) return null;
  // The title page names a dental or vision plan as such; a medical plan's mentions ("children's dental check-up") come later.
  const coverage: Coverage = /\b(dental)\b.{0,40}\b(plan|benefits?|ppo|dhmo|coverage)\b/i.test(head) ? "DENTAL" : /\b(vision)\b.{0,40}\b(plan|benefits|coverage)\b/i.test(head) ? "VISION" : "MEDICAL";
  const period = /Coverage Period:\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(head);
  return {
    kind: "PLAN_DOC",
    coverage,
    title,
    insurer: insurerOf(head) ?? /\b(Aetna|Cigna|Anthem|UnitedHealthcare|Humana|Delta Dental|Guardian|MetLife|VSP|EyeMed)\b/.exec(head)?.[1] ?? null,
    periodFrom: period ? `${period[3]}-${period[1]}-${period[2]}` : null,
    periodTo: period ? `${period[6]}-${period[4]}-${period[5]}` : null,
  };
}

/** The layout this reader knows: the lettered claims table. Others wait for their reader. */
export const readableEob = (text: string) => /Your claims up close/.test(text) && /Service type and date/.test(text);

/** An EOB this reader can't read yet (another insurer's layout, or dental/vision before their reader). */
export function pendingEob(text: string, coverage: Coverage): PendingEob {
  const date = /Statement date:\s*([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(text)?.[1];
  return { kind: "PENDING", coverage, insurer: insurerOf(text), statementDate: date ? longDate(date) : null };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");
export function longDate(s: string): string {
  const m = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(s.trim());
  const month = m ? MONTHS.indexOf(m[1]!) + 1 : 0;
  if (!m || !month) throw new Error(`Unreadable date "${s}"`);
  return `${m[3]}-${pad(month)}-${pad(Number(m[2]))}`;
}
export function slashDate(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s.trim());
  if (!m) throw new Error(`Unreadable date "${s}"`);
  const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
}
export const cents = (s: string) => {
  const v = Math.round(Number(s.replace(/[$,]/g, "")) * 100);
  if (!Number.isFinite(v)) throw new Error(`Unreadable amount "${s}"`);
  return v;
};
/** An amount as the table prints it: "1,677.19", "$9.94", and ".58" for cents alone. */
const AMOUNT = /^\$?-?(?:[\d,]+)?\.\d{2}$/;
const MONEY = String.raw`\$(-?[\d,]*\.\d{2})`;
const isMoney = (s: string) => /^\$-?[\d,]*\.\d{2}$/.test(s);
const isDate = (s: string) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s);
/** The page furniture repeated on every page, which can fall inside a section that runs across pages. */
const FURNITURE = /^(Continued on next page|Statement date:|Member:|Member ID:|Group name:|Group #:|Page \d+ of \d+)/;

function insurerOf(text: string): string | null {
  const first = /^(.+?)\s+(?:Life\s+)?Insurance Company/m.exec(text)?.[1]?.trim();
  return first || null;
}

type Row = { page: number; y: number; items: { x: number; x1: number; s: string }[]; text: string };

/** Items grouped into printed rows (baselines within 2pt), top to bottom, left to right. */
function rowsOf(items: PositionedItem[]): Row[] {
  const sorted = items
    .filter((i) => i.str.trim())
    .map((i) => ({ page: i.page, x: i.x, x1: i.x + i.width, y: i.y, s: i.str.trim() }))
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const rows: Row[] = [];
  for (const it of sorted) {
    const row = rows.findLast((r) => r.page === it.page && Math.abs(r.y - it.y) <= 2);
    if (row) row.items.push(it);
    else rows.push({ page: it.page, y: it.y, items: [it], text: "" });
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    r.text = r.items.map((i) => i.s).join(" ").replace(/\s+/g, " ").trim();
  }
  return rows;
}

const COLUMNS = ["billedCents", "memberRateCents", "pendingCents", "deductibleCents", "copayCents", "remainingCents", "planCents", "coinsuranceCents", "yourShareCents"] as const;
type Column = (typeof COLUMNS)[number];
export const zeroTotals = (): EobTotals => ({ billedCents: 0, memberRateCents: 0, pendingCents: 0, deductibleCents: 0, copayCents: 0, remainingCents: 0, planCents: 0, coinsuranceCents: 0, yourShareCents: 0 });

/** The amounts of a table row by column, and the remark numbers printed beside them. */
function amountsOf(row: Row, marks: number[], left: number): { values: Partial<Record<Column, number>>; remarks: number[] } {
  const values: Partial<Record<Column, number>> = {};
  const remarks: number[] = [];
  for (const it of row.items) {
    if (it.x < left) continue;
    for (const tok of it.s.split(/\s+/)) {
      const remark = /^\((\d{1,2})\)$/.exec(tok);
      if (remark) remarks.push(Number(remark[1]));
      if (!AMOUNT.test(tok)) continue;
      let col = -1;
      marks.forEach((c, i) => {
        if (c <= it.x1 - 3) col = i;
      });
      if (col < 0) throw new Error(`An amount (${tok}) left of the claims table's first column`);
      const key = COLUMNS[col]!;
      if (values[key] != null) throw new Error(`Two amounts in column ${"ABCDEFGHI"[col]} of one row ("${row.text}")`);
      values[key] = cents(tok);
    }
  }
  return { values, remarks };
}

const D = String.raw`(\d{1,2}\/\d{1,2}\/\d{2,4})`;
/**
 * A service line's words: what was done, its code, and the date (or the stay's first and
 * last day). The code is a 5-character procedure code (99213, J1100) or, on a hospital
 * claim, a 3-digit revenue code, sometimes printed against the words ("SERVICES722").
 */
const DESC_CODED = new RegExp(String.raw`^(.*?)(?:\s+|(?<=[A-Z]))(\d{3}|\d{5}|[A-Z]\d{4}|\d{4}[A-Z])\s+on\s+${D}(?:\s*-\s*${D})?$`);
const DESC_PLAIN = new RegExp(String.raw`^(.*?)\s+on\s+${D}(?:\s*-\s*${D})?$`);

/** Reads one EOB. Throws on a layout it can't follow, so the page lists the file instead of showing wrong figures. */
export function parseEob(text: string, items: PositionedItem[]): EobStatement {
  const coverage = eobCoverage(text);
  if (!coverage) throw new Error("Not an Explanation of Benefits");
  const rows = rowsOf(items);
  const dateText = /Statement date:\s*([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(text)?.[1];
  if (!dateText) throw new Error("No statement date");
  const group = /Group #:\s*(\S+)/.exec(text)?.[1] ?? null;
  const sponsors = [...text.matchAll(/Group name:\s*(.+)/g)].map((m) => m[1]!.trim().replace(/,$/, ""));
  const sponsor = sponsors.sort((a, b) => b.length - a.length)[0] ?? null;
  const plan =
    rows
      .map((r) => r.text.replace(/\s*(Continued on next page|Page \d+ of \d+)\s*/g, " ").trim())
      .find((t) => /®/.test(t) && !/Insurance Company/.test(t)) ?? null;

  const claims = new Map<string, EobClaim>();
  const payments: EobPayment[] = [];
  const balances: EobBalance[] = [];
  const remarkText = new Map<number, string>();
  const claimRemarks = new Map<string, Set<number>>();
  let balancesFrom: string | null = null;
  let balancesTo: string | null = null;

  type Mode = "none" | "header" | "lines" | "refs" | "after" | "cob" | "payments" | "remarks" | "balances";
  let mode: Mode = "none";
  let head: { patient: string; relationship: string | null; provider?: string; inNetwork?: boolean | null; id?: string; received?: string | null } | null = null;
  let claim: EobClaim | null = null;
  let marks: number[] = [];
  let line: (EobLine & { desc: string }) | null = null;
  let remarkNo: number | null = null;
  let person: string | null = null;
  let payCols: { provider: number; plan: number; sentTo: number; sentOn: number; you: number } | null = null;
  const lines = new Map<string, (EobLine & { desc: string })[]>();

  const finishLine = () => {
    if (!line || !claim) return;
    lines.get(claim.id)!.push(line);
    line = null;
  };

  for (const row of rows) {
    const t = row.text;
    const leftText = row.items.filter((i) => i.x < 130).map((i) => i.s).join(" ").trim();

    // Sections that start anywhere.
    const claimFor = /^Claim for (.+?) \(([^)]+)\)$/.exec(leftText);
    if (claimFor) {
      finishLine();
      head = { patient: claimFor[1]!, relationship: claimFor[2]! };
      mode = "header";
      continue;
    }
    if (/^COB fast facts$/.test(t) && claim) {
      mode = "cob";
      continue;
    }
    if (/^Patient Provider Amount Sent to Send date Amount$/.test(t)) {
      // Column edges from the header: names wrap onto the next row, so the row's text can't be split by pattern.
      const at = (s: string, nth = 0) => row.items.filter((i) => i.s === s || i.s.startsWith(`${s} `))[nth]!;
      payCols = { provider: at("Provider").x, plan: at("Amount").x1, sentTo: at("Sent").x, sentOn: at("Send").x, you: at("Amount", 1).x1 };
      mode = "payments";
      continue;
    }
    if (/^Your Claim Remarks$/.test(t)) {
      mode = "remarks";
      continue;
    }
    const bal = /^Your benefit balances to date for (\S+) to (\S+)$/.exec(t);
    if (bal) {
      balancesFrom = slashDate(bal[1]!);
      balancesTo = slashDate(bal[2]!);
      mode = "balances";
      person = null;
      continue;
    }

    if (mode === "header" && head) {
      const prov = /^Provider: (.+?)(?: \((In|Out-of|Out of)[- ]Network\))?$/.exec(leftText);
      if (prov) {
        head.provider = prov[1]!.trim();
        head.inNetwork = prov[2] ? prov[2] === "In" : null;
        continue;
      }
      const id = /^Claim ID: (\S+)/.exec(leftText);
      if (id) {
        head.id = id[1]!;
        continue;
      }
      const rec = /^Received on (\S+)/.exec(leftText);
      if (rec) {
        head.received = slashDate(rec[1]!);
        continue;
      }
      const letters = row.items.filter((i) => /^[A-I]$/.test(i.s));
      if (letters.length === 9 && /Service type and date/.test(t)) {
        if (!head.id) throw new Error(`A claim for ${head.patient} without its claim ID`);
        // A claim the plan didn't pay can print without its provider.
        head.provider ??= "";
        marks = letters.map((i) => (i.x + i.x1) / 2);
        const existing = claims.get(head.id);
        if (existing) claim = existing;
        else {
          const v = /^(.*?)(\d{2})$/.exec(head.id);
          claim = {
            id: head.id,
            baseId: v ? v[1]! : head.id,
            version: v ? Number(v[2]) : 0,
            patient: head.patient,
            relationship: head.relationship,
            provider: head.provider,
            inNetwork: head.inNetwork ?? null,
            received: head.received ?? null,
            lines: [],
            totals: zeroTotals(),
            alreadyPaidCents: 0,
            interestCents: 0,
            cob: null,
            remarks: {},
          };
          claims.set(head.id, claim);
          lines.set(head.id, []);
          claimRemarks.set(head.id, new Set());
        }
        mode = "lines";
      }
      continue;
    }

    if ((mode === "lines" || mode === "refs") && claim) {
      const left = marks[0]! - 20;
      const desc = row.items.filter((i) => i.x < left).map((i) => i.s).join(" ").trim();
      if (/^Totals:/.test(desc)) {
        finishLine();
        const { values } = amountsOf(row, marks, left);
        claim.totals = { ...zeroTotals(), ...values };
        mode = "after";
        continue;
      }
      if (/^Continued on next page/.test(t)) {
        finishLine();
        mode = "none";
        continue;
      }
      if (/^Refer to Remarks/.test(desc) || mode === "refs") {
        finishLine();
        for (const m of t.matchAll(/\((\d{1,2})\)/g)) claimRemarks.get(claim.id)!.add(Number(m[1]));
        mode = "refs";
        continue;
      }
      const { values, remarks } = amountsOf(row, marks, left);
      if (Object.keys(values).length && !desc && line) {
        // The same line's next cost-share tier (90% to the plan up to the out-of-pocket limit, 100% after): its amounts add.
        for (const [k, v] of Object.entries(values) as [Column, number][]) line[k] += v;
        remarks.forEach((n) => line!.remarks.push(n));
      } else if (Object.keys(values).length) {
        finishLine();
        line = { ...zeroTotals(), ...values, service: "", code: null, date: "", dateTo: null, remarks, desc };
        remarks.forEach((n) => claimRemarks.get(claim!.id)!.add(n));
      } else if (line && desc) line.desc = `${line.desc} ${desc}`.trim();
      continue;
    }

    if ((mode === "after" || mode === "cob") && claim) {
      const paid = new RegExp(`^Less Amount Already Paid ${MONEY}$`).exec(t);
      if (paid) claim.alreadyPaidCents = cents(paid[1]!);
      const interest = new RegExp(`Interest.*?${MONEY}$`).exec(t);
      if (interest && /interest/i.test(t)) claim.interestCents = cents(interest[1]!);
      const cob = new RegExp(`^${MONEY} ${MONEY} ${MONEY}$`).exec(t);
      if (mode === "cob" && cob) {
        claim.cob = { yourShareCents: cents(cob[1]!), otherPlanCents: cents(cob[2]!), planAfterCobCents: cents(cob[3]!) };
        mode = "none";
      }
      if (/^You can find all numbered claim remarks/.test(t) && mode === "after") mode = "none";
      continue;
    }

    if (mode === "payments" && payCols) {
      if (/^Total:/.test(t)) {
        mode = "none";
        continue;
      }
      if (FURNITURE.test(t) || /^Your payment summary/.test(t)) continue;
      const k = payCols;
      const words = (from: number, to: number) => row.items.filter((i) => i.x >= from - 5 && i.x < to - 5 && !isMoney(i.s) && !isDate(i.s)).map((i) => i.s).join(" ").trim();
      const near = (x1: number) => row.items.find((i) => isMoney(i.s) && Math.abs(i.x1 - x1) < 10);
      const who = /^(.+?) \(([^)]+)\)$/.exec(words(0, k.provider));
      const provider = words(k.provider, k.plan - 40);
      const sentTo = words(k.sentTo, k.sentOn);
      if (who) {
        const plan = near(k.plan);
        const you = near(k.you);
        if (!plan || !you) throw new Error(`Unreadable payment summary row "${t}"`);
        const on = row.items.find((i) => isDate(i.s));
        payments.push({ patient: who[1]!, relationship: who[2]!, provider, planCents: cents(plan.s), sentTo: sentTo || null, sentOn: on ? slashDate(on.s) : null, yourShareCents: cents(you.s) });
      } else if (payments.length && (provider || sentTo)) {
        // A name wrapped onto the next row.
        const last = payments.at(-1)!;
        if (provider) last.provider = `${last.provider} ${provider}`.trim();
        if (sentTo) last.sentTo = `${last.sentTo ?? ""} ${sentTo}`.trim();
      } else throw new Error(`Unreadable payment summary row "${t}"`);
      continue;
    }

    if (mode === "remarks") {
      if (/^Statement date:|^Member:|^Group|^Page \d+ of|^Continued on next page/.test(t)) continue;
      const r = /^\((\d{1,2})\)\s*(.*)$/.exec(t);
      if (r) {
        remarkNo = Number(r[1]);
        remarkText.set(remarkNo, r[2]!);
      } else if (remarkNo != null && !/^General Remarks:?$/.test(t)) remarkText.set(remarkNo, `${remarkText.get(remarkNo)} ${t}`);
      continue;
    }

    if (mode === "balances") {
      if (/^Family Balances/.test(t)) {
        person = null;
        continue;
      }
      if (/^\*?Limit includes/.test(t) || /^A complete list of your benefit balances/.test(t)) {
        if (/^A complete list/.test(t)) mode = "none";
        continue;
      }
      const who = /^(\S+) \(([^)]+)\)$/.exec(t);
      if (who) {
        person = who[1]!;
        continue;
      }
      const b = new RegExp(`^(\\w+) (In|Out of) Network (Deductible|Out of Pocket Maximum) ?(\\*?) ${MONEY} ${MONEY} ${MONEY}$`).exec(t);
      if (b) {
        const kind: BalanceKind = b[3] === "Deductible" ? "DEDUCTIBLE" : "OUT_OF_POCKET";
        balances.push({ person, benefit: b[1]!, inNetwork: b[2] === "In", kind, limitCents: cents(b[5]!), usedCents: cents(b[6]!), remainingCents: cents(b[7]!), includesPharmacy: b[4] === "*" && /Limit includes both \w+ and Pharmacy/.test(text) });
      }
    }
  }
  finishLine();

  for (const c of claims.values()) {
    c.lines = lines.get(c.id)!.map(({ desc, ...l }) => {
      const words = desc.replace(/\s+/g, " ").trim();
      const coded = DESC_CODED.exec(words);
      const plain = coded ? null : DESC_PLAIN.exec(words);
      if (coded) return { ...l, service: coded[1]!.trim(), code: coded[2]!, date: slashDate(coded[3]!), dateTo: coded[4] ? slashDate(coded[4]) : null };
      if (plain) return { ...l, service: plain[1]!.trim(), code: null, date: slashDate(plain[2]!), dateTo: plain[3] ? slashDate(plain[3]) : null };
      throw new Error(`Claim ${c.id}: a service line without its date ("${desc}")`);
    });
    if (!c.lines.length) throw new Error(`Claim ${c.id} has no service lines`);
    c.remarks = Object.fromEntries([...claimRemarks.get(c.id)!].sort((a, b) => a - b).flatMap((n) => (remarkText.has(n) ? [[n, remarkText.get(n)!.replace(/\s+/g, " ").trim()]] : [])));
  }
  if (!claims.size && !payments.length) throw new Error("No claims found");

  return {
    kind: "EOB",
    coverage,
    insurer: insurerOf(text) ?? "Unknown insurer",
    plan,
    sponsor,
    group,
    statementDate: longDate(dateText),
    claims: [...claims.values()],
    payments,
    balancesFrom,
    balancesTo,
    balances,
  };
}
