import { describe, expect, it } from "vitest";
import { classifyTransaction, type ClassifyContext } from "../../classifier/classify.ts";
import { validateDocument } from "../validate.ts";
import { parseStatementText } from "./index.ts";

// Synthetic statement in Bilt's real text layout (names and figures are made up).
const TEXT = `New balance as of Jun 25, 2026
$1,000.00
Balance breakdown
Previous balance \t$0.00
Payments and credits \t-$5,100.00
Purchases (Including New Card Purchases) \t$6,100.00
Pat Example
pat@example.com
Bilt Blue Card
May 25 – Jun 25, 2026
Cardless Inc. is the servicer of the Bilt Cards. Cardless is a financial technology company.
Page 1 of 2

-- 1 of 2 --

Payments and credits
Date \tDescription \tAmount
May 30, 2026 \tBILT RENT CHARGE ADJUSTMENT \t-$5,000.00
Jun 2, 2026 \tPAYMENT \t-$100.00
Total payments and credits in this period \t-$5,100.00
Transactions
Date \tDescription \tAmount
May 29, 2026 \tBPS*BILT HOUSING 1 Main St New York
10014 NY USA
$5,000.00
May 31, 2026 \tAMAZON MKTPL*XYZ Terry Ave N
SEATTLE 98109 WA USA
$40.00
Pat Example
pat@example.com
Bilt Blue Card
May 25 – Jun 25, 2026
Jun 9, 2026 \tSELF PARKING 1 HOSPITAL PLAZA
SPRINGFIELD 01105 CT USA
$2.00
Total new charges in this period \t$5,042.00
Sam's transactions \tAuthorized user
Date \tDescription \tAmount
Jun 10, 2026 \tCVS PHARMACY #1 1 MAIN ST
HARTFORD 06103 CT USA
$1,058.00
Total new charges in this period \t$1,058.00
Fees
Date \tDescription \tAmount
- \t$0.00
Total fees charged in this period \t$0.00
9900000001234567 \tPage 2 of 2
`;

const CTX: ClassifyContext = { mergeDate: "2024-12-01", userRules: [] };

describe("Bilt card statement", () => {
  const o = parseStatementText(TEXT);
  if (!o.ok) throw new Error(JSON.stringify(o));
  const s = o.doc.sections[0]!;

  it("stores the card as owing money (negative) and ties out to the cent", () => {
    expect(o.parserId).toBe("bilt-card");
    expect(s).toMatchObject({ institution: "Bilt", accountNumber: "9900000001234567", periodStart: "2026-05-25", periodEnd: "2026-06-25", openingBalanceCents: 0, closingBalanceCents: -100_000 });
    expect(validateDocument(o.doc).ok).toBe(true);
  });

  it("flips signs, joins wrapped descriptions and tags the authorized user", () => {
    const by = (d: string) => s.transactions.find((t) => t.description.startsWith(d))!;
    expect(by("PAYMENT")).toMatchObject({ amountCents: 10_000, section: "Payments" });
    expect(by("BPS*BILT HOUSING")).toMatchObject({ amountCents: -500_000 });
    expect(by("BPS*BILT HOUSING").description).toContain("NY USA");
    expect(by("CVS PHARMACY")).toMatchObject({ amountCents: -105_800, cardMember: "Sam" });
    expect(s.transactions).toHaveLength(6);
  });

  it("counts Bilt rent charge and its adjustment as Housing so rent isn't counted twice", () => {
    const classify = (d: string) => {
      const t = s.transactions.find((x) => x.description.startsWith(d))!;
      return classifyTransaction({ institution: "Bilt", accountSubtype: "CREDIT_CARD", section: t.section, description: t.description, amountCents: t.amountCents, date: t.date }, CTX);
    };
    expect(classify("BPS*BILT HOUSING")).toMatchObject({ lane: "EXPENSE", category: "Housing & utilities" });
    expect(classify("BILT RENT CHARGE ADJUSTMENT")).toMatchObject({ lane: "EXPENSE", category: "Housing & utilities" });
    expect(classify("PAYMENT").lane).toBe("TRANSFER");
  });

  it("pairs bank payments to Bilt as own-account transfers, not untracked card spending", () => {
    const c = classifyTransaction({ institution: "Chase", accountSubtype: "CHECKING", description: "Bilt Card Pmt PPD ID: 1", amountCents: -10_000, date: "2026-06-03" }, CTX);
    expect(c.lane).toBe("TRANSFER");
    expect(c.counterparty).toMatchObject({ institution: "Bilt", subtypes: ["CREDIT_CARD"] });
  });
});
