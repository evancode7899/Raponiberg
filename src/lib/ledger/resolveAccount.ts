import type { AccountType, Prisma, PrismaClient } from "@prisma/client";
import { addDays } from "../dates/isoDate.ts";
import type { ParsedAccountSection } from "../ingest/types.ts";
import { parseIsoDate } from "../statements/parseIsoDate.ts";

type Db = PrismaClient | Prisma.TransactionClient;

export type AccountResolution = {
  accountId: string;
  how: "ALIAS" | "CONTINUATION" | "ADOPTED" | "CREATED";
  accountName: string;
};

const KIND_TO_TYPE: Record<ParsedAccountSection["kind"], AccountType> = {
  CHECKING: "CHECKING",
  SAVINGS: "SAVINGS",
  CREDIT_CARD: "CREDIT_CARD",
  INVESTMENT: "INVESTMENT",
  OTHER: "OTHER",
};

/** "Amex Gold Card" + "0-12345" → "Amex Gold Card ••2345"; with its holder, "Amex Gold Card — Sam ••2345". */
export function displayName(section: ParsedAccountSection, holder?: string | null): string {
  const digits = section.accountNumber.replace(/\D/g, "");
  const name = holder ? `${section.accountName} — ${holder}` : section.accountName;
  return digits.length >= 4 ? `${name} ••${digits.slice(-4)}` : name;
}

/** A household member as documents name them (the tax profile's persons). */
export type Holder = { name: string; match: string[] };

/**
 * The one household member a card statement belongs to, by the card-member name it prints
 * on its rows: their first name, when nearly every row (90%) names a card member and every
 * one is the same person. Null for a card two people use, or one that prints no names. The
 * name goes into the new account's name, which is how the app tells whose account it is
 * (book/owners.ts), so a partner's own card is theirs from its first import.
 */
export function cardHolder(section: ParsedAccountSection, persons: Holder[]): string | null {
  if (section.kind !== "CREDIT_CARD" || !persons.length || !section.transactions.length) return null;
  const named = section.transactions.map((t) => t.cardMember?.toUpperCase().trim()).filter((m): m is string => !!m);
  if (named.length < 0.9 * section.transactions.length) return null;
  const who = new Set(named.map((m) => {
    const ps = persons.filter((p) => p.match.some((x) => x && m.includes(x.toUpperCase())));
    return ps.length === 1 ? ps[0]!.name : null;
  }));
  const [only] = who;
  return who.size === 1 && only ? only.split(/\s+/)[0]! : null;
}

/**
 * Finds (or creates) the account a statement section belongs to, so new accounts and
 * new cards are picked up automatically as statements arrive:
 *
 * 1. ALIAS — the institution/number has been seen before.
 * 2. CONTINUATION — a reissued card or renumbered account: same institution and
 *    product, and this statement picks up exactly where an existing account's history
 *    ends (period contiguous within a few days AND opening = that account's closing),
 *    or ends exactly where its history begins (backfilling older statements later).
 *    Balance continuity to the cent is what makes this safe to do automatically.
 * 3. ADOPTED — an account created by hand (no aliases, no statements yet) at the same
 *    institution with the same type.
 * 4. CREATED — a brand-new account, named for its holder when a card prints one (cardHolder).
 */
export async function resolveAccount(db: Db, section: ParsedAccountSection, persons: Holder[] = []): Promise<AccountResolution> {
  const alias = await db.accountAlias.findUnique({
    where: { institution_identifier: { institution: section.institution, identifier: section.accountNumber } },
    include: { account: { select: { name: true } } },
  });
  if (alias) return { accountId: alias.accountId, how: "ALIAS", accountName: alias.account.name };

  const type = KIND_TO_TYPE[section.kind];
  const sameKind = await db.account.findMany({
    where: { institution: section.institution, type, subtype: section.subtype, archivedAt: null },
    include: {
      statementImports: {
        where: { isSummary: false },
        orderBy: { periodStart: "asc" },
        select: { periodStart: true, periodEnd: true, openingBalanceCents: true, closingBalanceCents: true },
      },
      aliases: { select: { identifier: true } },
    },
  });
  const start = parseIsoDate(section.periodStart);
  const near = (a: Date, b: Date, days: number) => Math.abs(a.getTime() - b.getTime()) <= days * 86_400_000;
  for (const acct of sameKind) {
    if (!acct.name.startsWith(section.accountName)) continue;
    const first = acct.statementImports[0];
    const last = acct.statementImports.at(-1);
    if (!first || !last) continue;
    const continuesAfter =
      near(parseIsoDate(addDays(last.periodEnd.toISOString().slice(0, 10), 1)), start, 3) &&
      last.closingBalanceCents === section.openingBalanceCents;
    const precedesBefore =
      near(parseIsoDate(addDays(section.periodEnd, 1)), first.periodStart, 3) &&
      section.closingBalanceCents === first.openingBalanceCents;
    if (continuesAfter || precedesBefore) {
      await db.accountAlias.create({
        data: { accountId: acct.id, institution: section.institution, identifier: section.accountNumber, source: "CONTINUATION" },
      });
      return { accountId: acct.id, how: "CONTINUATION", accountName: acct.name };
    }
  }

  const orphan = await db.account.findFirst({
    where: {
      institution: { equals: section.institution },
      type,
      archivedAt: null,
      aliases: { none: {} },
      statementImports: { none: {} },
    },
  });
  if (orphan) {
    await db.account.update({
      where: { id: orphan.id },
      data: { subtype: section.subtype },
    });
    await db.accountAlias.create({
      data: { accountId: orphan.id, institution: section.institution, identifier: section.accountNumber, source: "ADOPTED" },
    });
    return { accountId: orphan.id, how: "ADOPTED", accountName: orphan.name };
  }

  const name = displayName(section, cardHolder(section, persons));
  const created = await db.account.create({
    data: {
      name,
      type,
      subtype: section.subtype,
      institution: section.institution,
      aliases: { create: { institution: section.institution, identifier: section.accountNumber } },
    },
  });
  return { accountId: created.id, how: "CREATED", accountName: name };
}
