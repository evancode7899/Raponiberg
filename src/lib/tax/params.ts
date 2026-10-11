/**
 * Tax-law constants by tax year. Every money amount is integer cents.
 *
 * Sources:
 * - Federal 2026: IRS Rev. Proc. 2025-32 (inflation adjustments incl. the One Big
 *   Beautiful Bill Act), SSA 2026 wage base. Federal 2025: Rev. Proc. 2024-40 as
 *   amended by the OBBBA (standard deduction, SALT cap, child tax credit).
 * - Connecticut: Form CT-1040 TCS (Rev. 12/25) Tables A–E. Connecticut does not index
 *   these, so 2026 reuses them; the 2026 CT child tax credit is from 2026 sSB 6.
 * - New York: IT-201-I / IT-203-I rate schedules, tax computation worksheets and the NYC
 *   school tax credit. New York doesn't index its brackets either.
 *
 * A new tax year is a new entry here; nothing else hard-codes a rate or threshold.
 */

export type FilingStatus = "MFJ" | "MFS" | "SINGLE" | "HOH";

export const FILING_STATUS_LABEL: Record<FilingStatus, string> = {
  MFJ: "Married filing jointly",
  MFS: "Married filing separately",
  SINGLE: "Single",
  HOH: "Head of household",
};

type ByStatus<T> = Record<FilingStatus, T>;

const $ = (dollars: number) => Math.round(dollars * 100);
const byStatus = <T,>(single: T, mfj: T, mfs: T, hoh: T): ByStatus<T> => ({ SINGLE: single, MFJ: mfj, MFS: mfs, HOH: hoh });

/** Upper bounds of each bracket below the top one, paired with FEDERAL_RATES. */
export const FEDERAL_RATES = [0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37] as const;

export type FederalParams = {
  /** Six upper bounds (10% … 35%); income above the last is taxed at 37%. */
  brackets: ByStatus<number[]>;
  standardDeduction: ByStatus<number>;
  /** Qualified dividends / long-term gains: top of the 0% band and of the 15% band. */
  capitalGains: ByStatus<{ zeroMax: number; fifteenMax: number }>;
  childTaxCredit: {
    perChild: number;
    refundablePerChild: number;
    /** Credit drops $50 per $1,000 (or part) of MAGI above this. */
    phaseoutStart: ByStatus<number>;
    otherDependent: number;
  };
  salt: { cap: ByStatus<number>; phaseoutStart: ByStatus<number>; floor: ByStatus<number>; phaseoutRate: number };
  qbiThreshold: ByStatus<number>;
  amt: {
    exemption: ByStatus<number>;
    phaseoutStart: ByStatus<number>;
    phaseoutRate: number;
    rate28Above: ByStatus<number>;
  };
  /** Additional Medicare tax and NIIT share these (statutory, never indexed). */
  surtaxThreshold: ByStatus<number>;
  capitalLossLimit: ByStatus<number>;
  /** Cash gifts deductible on top of the standard deduction (from 2026). */
  charitableNonItemizer: ByStatus<number>;
  /** Itemizers deduct charity only above this share of AGI (from 2026). */
  charitableAgiFloor: number;
  /** From 2026, itemized deductions are cut by 2/37 of the part reaching the 37% bracket. */
  itemizedLimitation37: boolean;
  dependentCare: {
    /** Max expenses counted: one child / two or more. */
    expenseLimit: [number, number];
    /** Dependent-care FSA exclusion limit (MFS gets half). */
    fsaLimit: number;
    /** 2026+: 50% → 35% (1 pt per $2k over $15k) → 20% (1 pt per $2k/$4k MFJ over $75k/$150k). */
    enhanced: boolean;
  };
  socialSecurity: { wageBase: number; rate: number };
  medicareRate: number;
  additionalMedicareRate: number;
  niitRate: number;
  limits: { k401: number; ira: number; hsaSelf: number; hsaFamily: number };
  retirement: RetirementLimits;
  /** Prior-year safe harbor rises to 110% when prior-year AGI exceeds this. */
  safeHarborHighAgi: ByStatus<number>;
  /**
   * A dependent child's unearned income (Form 8615): the first `exempt` is tax-free, the
   * band up to `threshold` is taxed at the child's rate, the rest at the parents'. Above
   * `exempt` the child must file; parents may instead report it on their own return
   * (Form 8814) while it's under `parentElectionMax`.
   */
  kiddie: { exempt: number; threshold: number; parentElectionMax: number };
};

/** Everything beyond the base limits that decides tax-advantaged room (IRS notices 2024-80, 2025-67). */
export type RetirementLimits = {
  /** 401(k)/403(b) catch-up at 50+; ages 60–63 get the larger "super" catch-up instead. */
  k401CatchUp: number;
  k401CatchUp60to63: number;
  /** §415(c): employee + employer + after-tax additions to one employer's plans. */
  annualAdditions: number;
  iraCatchUp: number;
  hsaCatchUp55: number;
  /** Direct Roth IRA contributions phase out across this MAGI range. */
  rothIraPhaseout: ByStatus<{ start: number; end: number }>;
  /** Traditional IRA deduction phase-out when covered by a workplace plan… */
  tradIraCoveredPhaseout: ByStatus<{ start: number; end: number }>;
  /** …and when only the spouse is covered (married filing jointly). */
  tradIraSpouseCoveredPhaseout: { start: number; end: number };
  /** From 2026, catch-ups must be Roth for those whose prior-year FICA wages from the employer exceeded this (null before). */
  rothCatchUpWageThreshold: number | null;
};

export type CtParams = {
  /** Table A: personal exemption, reduced $1,000 per $1,000 (or part) of CT AGI over the start. */
  exemption: ByStatus<{ amount: number; phaseoutStart: number }>;
  /** Table B: brackets as [upper bound, rate]; last upper bound is Infinity. */
  brackets: ByStatus<[number, number][]>;
  /** Table C: 2% rate phase-out add-back. */
  addBack: ByStatus<RecaptureTier>;
  /** Table D: benefit recapture, in up to three tiers. */
  recapture: ByStatus<RecaptureTier[]>;
  /** Table E: [CT AGI upper bound (inclusive), credit decimal]; above the last → 0. */
  personalCredit: ByStatus<[number, number][]>;
  /** Contributions to CHET (CT's 529) deductible per return. */
  chetDeduction: ByStatus<number>;
  childCredit: { perChild: number; maxChildren: number; fullBelow: ByStatus<number>; zeroAbove: ByStatus<number> } | null;
  /** Paid Family & Medical Leave employee contribution (payroll, not income tax). */
  pfmlRate: number;
};

/** "AGI over `start`: `per` for each `step` (or part), capped at `max`." */
export type RecaptureTier = { start: number; step: number; per: number; max: number };

const FED_2026: FederalParams = {
  brackets: byStatus(
    [12_400, 50_400, 105_700, 201_775, 256_225, 640_600].map($),
    [24_800, 100_800, 211_400, 403_550, 512_450, 768_700].map($),
    [12_400, 50_400, 105_700, 201_775, 256_225, 384_350].map($),
    [17_700, 67_450, 105_700, 201_750, 256_200, 640_600].map($),
  ),
  standardDeduction: byStatus($(16_100), $(32_200), $(16_100), $(24_150)),
  capitalGains: byStatus(
    { zeroMax: $(49_450), fifteenMax: $(545_500) },
    { zeroMax: $(98_900), fifteenMax: $(613_700) },
    { zeroMax: $(49_450), fifteenMax: $(306_850) },
    { zeroMax: $(66_200), fifteenMax: $(579_600) },
  ),
  childTaxCredit: {
    perChild: $(2_200),
    refundablePerChild: $(1_700),
    phaseoutStart: byStatus($(200_000), $(400_000), $(200_000), $(200_000)),
    otherDependent: $(500),
  },
  salt: {
    cap: byStatus($(40_400), $(40_400), $(20_200), $(40_400)),
    phaseoutStart: byStatus($(505_000), $(505_000), $(252_500), $(505_000)),
    floor: byStatus($(10_000), $(10_000), $(5_000), $(10_000)),
    phaseoutRate: 0.3,
  },
  qbiThreshold: byStatus($(201_750), $(403_500), $(201_775), $(201_750)),
  amt: {
    exemption: byStatus($(90_100), $(140_200), $(70_100), $(90_100)),
    phaseoutStart: byStatus($(500_000), $(1_000_000), $(500_000), $(500_000)),
    phaseoutRate: 0.5,
    rate28Above: byStatus($(244_500), $(244_500), $(122_250), $(244_500)),
  },
  surtaxThreshold: byStatus($(200_000), $(250_000), $(125_000), $(200_000)),
  capitalLossLimit: byStatus($(3_000), $(3_000), $(1_500), $(3_000)),
  charitableNonItemizer: byStatus($(1_000), $(2_000), $(1_000), $(1_000)),
  charitableAgiFloor: 0.005,
  itemizedLimitation37: true,
  dependentCare: { expenseLimit: [$(3_000), $(6_000)], fsaLimit: $(7_500), enhanced: true },
  socialSecurity: { wageBase: $(184_500), rate: 0.062 },
  medicareRate: 0.0145,
  additionalMedicareRate: 0.009,
  niitRate: 0.038,
  limits: { k401: $(24_500), ira: $(7_500), hsaSelf: $(4_400), hsaFamily: $(8_750) },
  retirement: {
    k401CatchUp: $(8_000),
    k401CatchUp60to63: $(11_250),
    annualAdditions: $(72_000),
    iraCatchUp: $(1_100),
    hsaCatchUp55: $(1_000),
    rothIraPhaseout: byStatus({ start: $(153_000), end: $(168_000) }, { start: $(242_000), end: $(252_000) }, { start: 0, end: $(10_000) }, { start: $(153_000), end: $(168_000) }),
    tradIraCoveredPhaseout: byStatus({ start: $(81_000), end: $(91_000) }, { start: $(129_000), end: $(149_000) }, { start: 0, end: $(10_000) }, { start: $(81_000), end: $(91_000) }),
    tradIraSpouseCoveredPhaseout: { start: $(242_000), end: $(252_000) },
    rothCatchUpWageThreshold: $(150_000),
  },
  safeHarborHighAgi: byStatus($(150_000), $(150_000), $(75_000), $(150_000)),
  // Rev. Proc. 2025-32 §4.02; unchanged from 2025.
  kiddie: { exempt: $(1_350), threshold: $(2_700), parentElectionMax: $(13_500) },
};

const FED_2025: FederalParams = {
  ...FED_2026,
  brackets: byStatus(
    [11_925, 48_475, 103_350, 197_300, 250_525, 626_350].map($),
    [23_850, 96_950, 206_700, 394_600, 501_050, 751_600].map($),
    [11_925, 48_475, 103_350, 197_300, 250_525, 375_800].map($),
    [17_000, 64_850, 103_350, 197_300, 250_500, 626_350].map($),
  ),
  standardDeduction: byStatus($(15_750), $(31_500), $(15_750), $(23_625)),
  capitalGains: byStatus(
    { zeroMax: $(48_350), fifteenMax: $(533_400) },
    { zeroMax: $(96_700), fifteenMax: $(600_050) },
    { zeroMax: $(48_350), fifteenMax: $(300_000) },
    { zeroMax: $(64_750), fifteenMax: $(566_700) },
  ),
  salt: {
    cap: byStatus($(40_000), $(40_000), $(20_000), $(40_000)),
    phaseoutStart: byStatus($(500_000), $(500_000), $(250_000), $(500_000)),
    floor: byStatus($(10_000), $(10_000), $(5_000), $(10_000)),
    phaseoutRate: 0.3,
  },
  qbiThreshold: byStatus($(197_300), $(394_600), $(197_300), $(197_300)),
  amt: {
    exemption: byStatus($(88_100), $(137_000), $(68_500), $(88_100)),
    phaseoutStart: byStatus($(626_350), $(1_252_700), $(626_350), $(626_350)),
    phaseoutRate: 0.25,
    rate28Above: byStatus($(239_100), $(239_100), $(119_550), $(239_100)),
  },
  charitableNonItemizer: byStatus(0, 0, 0, 0),
  charitableAgiFloor: 0,
  itemizedLimitation37: false,
  dependentCare: { expenseLimit: [$(3_000), $(6_000)], fsaLimit: $(5_000), enhanced: false },
  socialSecurity: { wageBase: $(176_100), rate: 0.062 },
  limits: { k401: $(23_500), ira: $(7_000), hsaSelf: $(4_300), hsaFamily: $(8_550) },
  retirement: {
    k401CatchUp: $(7_500),
    k401CatchUp60to63: $(11_250),
    annualAdditions: $(70_000),
    iraCatchUp: $(1_000),
    hsaCatchUp55: $(1_000),
    rothIraPhaseout: byStatus({ start: $(150_000), end: $(165_000) }, { start: $(236_000), end: $(246_000) }, { start: 0, end: $(10_000) }, { start: $(150_000), end: $(165_000) }),
    tradIraCoveredPhaseout: byStatus({ start: $(79_000), end: $(89_000) }, { start: $(126_000), end: $(146_000) }, { start: 0, end: $(10_000) }, { start: $(79_000), end: $(89_000) }),
    tradIraSpouseCoveredPhaseout: { start: $(236_000), end: $(246_000) },
    rothCatchUpWageThreshold: null,
  },
};

/** Rev. Proc. 2023-34 (2024 inflation adjustments), SSA 2024 wage base; before the OBBBA. */
const FED_2024: FederalParams = {
  ...FED_2025,
  brackets: byStatus(
    [11_600, 47_150, 100_525, 191_950, 243_725, 609_350].map($),
    [23_200, 94_300, 201_050, 383_900, 487_450, 731_200].map($),
    [11_600, 47_150, 100_525, 191_950, 243_725, 365_600].map($),
    [16_550, 63_100, 100_500, 191_950, 243_700, 609_350].map($),
  ),
  standardDeduction: byStatus($(14_600), $(29_200), $(14_600), $(21_900)),
  capitalGains: byStatus(
    { zeroMax: $(47_025), fifteenMax: $(518_900) },
    { zeroMax: $(94_050), fifteenMax: $(583_750) },
    { zeroMax: $(47_025), fifteenMax: $(291_850) },
    { zeroMax: $(63_000), fifteenMax: $(551_350) },
  ),
  childTaxCredit: {
    perChild: $(2_000),
    refundablePerChild: $(1_700),
    phaseoutStart: byStatus($(200_000), $(400_000), $(200_000), $(200_000)),
    otherDependent: $(500),
  },
  salt: {
    cap: byStatus($(10_000), $(10_000), $(5_000), $(10_000)),
    phaseoutStart: byStatus(Infinity, Infinity, Infinity, Infinity),
    floor: byStatus($(10_000), $(10_000), $(5_000), $(10_000)),
    phaseoutRate: 0,
  },
  qbiThreshold: byStatus($(191_950), $(383_900), $(191_950), $(191_950)),
  amt: {
    exemption: byStatus($(85_700), $(133_300), $(66_650), $(85_700)),
    phaseoutStart: byStatus($(609_350), $(1_218_700), $(609_350), $(609_350)),
    phaseoutRate: 0.25,
    rate28Above: byStatus($(232_600), $(232_600), $(116_300), $(232_600)),
  },
  socialSecurity: { wageBase: $(168_600), rate: 0.062 },
  limits: { k401: $(23_000), ira: $(7_000), hsaSelf: $(4_150), hsaFamily: $(8_300) },
  retirement: {
    ...FED_2025.retirement,
    k401CatchUp60to63: $(7_500),
    annualAdditions: $(69_000),
    rothIraPhaseout: byStatus({ start: $(146_000), end: $(161_000) }, { start: $(230_000), end: $(240_000) }, { start: 0, end: $(10_000) }, { start: $(146_000), end: $(161_000) }),
    tradIraCoveredPhaseout: byStatus({ start: $(77_000), end: $(87_000) }, { start: $(123_000), end: $(143_000) }, { start: 0, end: $(10_000) }, { start: $(77_000), end: $(87_000) }),
    tradIraSpouseCoveredPhaseout: { start: $(230_000), end: $(240_000) },
  },
  kiddie: { exempt: $(1_300), threshold: $(2_600), parentElectionMax: $(13_000) },
};

const tier = (start: number, step: number, per: number, max: number): RecaptureTier => ({
  start: $(start),
  step: $(step),
  per: $(per),
  max: $(max),
});

const CT_SINGLE_BRACKETS: [number, number][] = [
  [$(10_000), 0.02],
  [$(50_000), 0.045],
  [$(100_000), 0.055],
  [$(200_000), 0.06],
  [$(250_000), 0.065],
  [$(500_000), 0.069],
  [Infinity, 0.0699],
];
const double = (b: [number, number][]): [number, number][] => b.map(([u, r]) => [u * 2, r]);
const CT_SINGLE_RECAPTURE = [tier(105_000, 5_000, 25, 250), tier(200_000, 5_000, 90, 2_950), tier(500_000, 5_000, 50, 3_400)];
const CT_SINGLE_CREDIT: [number, number][] = creditTable([
  [18_800, 0.75], [19_300, 0.7], [19_800, 0.65], [20_300, 0.6], [20_800, 0.55], [21_300, 0.5], [21_800, 0.45],
  [22_300, 0.4], [25_000, 0.35], [25_500, 0.3], [26_000, 0.25], [26_500, 0.2], [31_300, 0.15], [31_800, 0.14],
  [32_300, 0.13], [32_800, 0.12], [33_300, 0.11], [60_000, 0.1], [60_500, 0.09], [61_000, 0.08], [61_500, 0.07],
  [62_000, 0.06], [62_500, 0.05], [63_000, 0.04], [63_500, 0.03], [64_000, 0.02], [64_500, 0.01],
]);

/** Table E rows in dollars → cents. Below the first row the exemption already zeroes the tax. */
function creditTable(rows: [number, number][]): [number, number][] {
  return rows.map(([u, d]) => [$(u), d]);
}

const CT_2025: CtParams = {
  exemption: byStatus(
    { amount: $(15_000), phaseoutStart: $(30_000) },
    { amount: $(24_000), phaseoutStart: $(48_000) },
    { amount: $(12_000), phaseoutStart: $(24_000) },
    { amount: $(19_000), phaseoutStart: $(38_000) },
  ),
  brackets: byStatus(CT_SINGLE_BRACKETS, double(CT_SINGLE_BRACKETS), CT_SINGLE_BRACKETS, [
    [$(16_000), 0.02],
    [$(80_000), 0.045],
    [$(160_000), 0.055],
    [$(320_000), 0.06],
    [$(400_000), 0.065],
    [$(800_000), 0.069],
    [Infinity, 0.0699],
  ]),
  addBack: byStatus(
    tier(56_500, 5_000, 25, 250),
    tier(100_500, 5_000, 50, 500),
    tier(50_250, 2_500, 25, 250),
    tier(78_500, 4_000, 40, 400),
  ),
  recapture: byStatus(
    CT_SINGLE_RECAPTURE,
    [tier(210_000, 10_000, 50, 500), tier(400_000, 10_000, 180, 5_900), tier(1_000_000, 10_000, 100, 6_800)],
    CT_SINGLE_RECAPTURE,
    [tier(168_000, 8_000, 40, 400), tier(320_000, 8_000, 140, 4_600), tier(800_000, 8_000, 80, 5_320)],
  ),
  personalCredit: byStatus(
    CT_SINGLE_CREDIT,
    creditTable([
      [30_000, 0.75], [30_500, 0.7], [31_000, 0.65], [31_500, 0.6], [32_000, 0.55], [32_500, 0.5], [33_000, 0.45],
      [33_500, 0.4], [40_000, 0.35], [40_500, 0.3], [41_000, 0.25], [41_500, 0.2], [50_000, 0.15], [50_500, 0.14],
      [51_000, 0.13], [51_500, 0.12], [52_000, 0.11], [96_000, 0.1], [96_500, 0.09], [97_000, 0.08], [97_500, 0.07],
      [98_000, 0.06], [98_500, 0.05], [99_000, 0.04], [99_500, 0.03], [100_000, 0.02], [100_500, 0.01],
    ]),
    creditTable([
      [15_000, 0.75], [15_500, 0.7], [16_000, 0.65], [16_500, 0.6], [17_000, 0.55], [17_500, 0.5], [18_000, 0.45],
      [18_500, 0.4], [20_000, 0.35], [20_500, 0.3], [21_000, 0.25], [21_500, 0.2], [25_000, 0.15], [25_500, 0.14],
      [26_000, 0.13], [26_500, 0.12], [27_000, 0.11], [48_000, 0.1], [48_500, 0.09], [49_000, 0.08], [49_500, 0.07],
      [50_000, 0.06], [50_500, 0.05], [51_000, 0.04], [51_500, 0.03], [52_000, 0.02], [52_500, 0.01],
    ]),
    creditTable([
      [24_000, 0.75], [24_500, 0.7], [25_000, 0.65], [25_500, 0.6], [26_000, 0.55], [26_500, 0.5], [27_000, 0.45],
      [27_500, 0.4], [34_000, 0.35], [34_500, 0.3], [35_000, 0.25], [35_500, 0.2], [44_000, 0.15], [44_500, 0.14],
      [45_000, 0.13], [45_500, 0.12], [46_000, 0.11], [74_000, 0.1], [74_500, 0.09], [75_000, 0.08], [75_500, 0.07],
      [76_000, 0.06], [76_500, 0.05], [77_000, 0.04], [77_500, 0.03], [78_000, 0.02], [78_500, 0.01],
    ]),
  ),
  chetDeduction: byStatus($(5_000), $(10_000), $(5_000), $(5_000)),
  childCredit: null,
  pfmlRate: 0.005,
};

const CT_2026: CtParams = {
  ...CT_2025,
  childCredit: {
    perChild: $(600),
    maxChildren: 3,
    fullBelow: byStatus($(100_000), $(200_000), $(100_000), $(160_000)),
    zeroAbove: byStatus($(109_000), $(209_000), $(109_000), $(169_000)),
  },
};

/**
 * New York State (IT-201 / IT-203) and New York City (resident tax, IT-360.1). Brackets are
 * [upper bound, rate]; the last upper bound is Infinity. New York doesn't index them.
 */
export type NyParams = {
  brackets: ByStatus<[number, number][]>;
  standardDeduction: ByStatus<number>;
  dependentExemption: number;
  /**
   * Above this New York AGI the benefit of the lower brackets is taken back (the tax
   * computation worksheets), phased in over `recapturePhaseIn` of AGI; above `flatAbove`
   * every dollar is taxed at the top rate.
   */
  recaptureAgi: number;
  recapturePhaseIn: number;
  flatAbove: number;
  /** Below this taxable income (and AGI up to `recaptureAgi`) the tax table's $50 bands are used. */
  tableBelow: number;
  nyc: {
    brackets: ByStatus<[number, number][]>;
    /** School tax credit, fixed amount: for income up to `incomeLimit`, prorated by months for part-year residents. */
    schoolCredit: { amount: ByStatus<number>; incomeLimit: number };
    /** School tax credit, rate reduction: NYC taxable income up to `incomeLimit`. */
    schoolRateReduction: { incomeLimit: number; firstBand: ByStatus<number>; firstRate: number; base: ByStatus<number>; rate: number };
  };
};

const NY_2025: NyParams = {
  brackets: byStatus(
    [[$(8_500), 0.04], [$(11_700), 0.045], [$(13_900), 0.0525], [$(80_650), 0.055], [$(215_400), 0.06], [$(1_077_550), 0.0685], [$(5_000_000), 0.0965], [$(25_000_000), 0.103], [Infinity, 0.109]],
    [[$(17_150), 0.04], [$(23_600), 0.045], [$(27_900), 0.0525], [$(161_550), 0.055], [$(323_200), 0.06], [$(2_155_350), 0.0685], [$(5_000_000), 0.0965], [$(25_000_000), 0.103], [Infinity, 0.109]],
    [[$(8_500), 0.04], [$(11_700), 0.045], [$(13_900), 0.0525], [$(80_650), 0.055], [$(215_400), 0.06], [$(1_077_550), 0.0685], [$(5_000_000), 0.0965], [$(25_000_000), 0.103], [Infinity, 0.109]],
    [[$(12_800), 0.04], [$(17_650), 0.045], [$(20_900), 0.0525], [$(107_650), 0.055], [$(269_300), 0.06], [$(1_616_450), 0.0685], [$(5_000_000), 0.0965], [$(25_000_000), 0.103], [Infinity, 0.109]],
  ),
  standardDeduction: byStatus($(8_000), $(16_050), $(8_000), $(11_200)),
  dependentExemption: $(1_000),
  recaptureAgi: $(107_650),
  recapturePhaseIn: $(50_000),
  flatAbove: $(25_000_000),
  tableBelow: $(65_000),
  nyc: {
    brackets: byStatus(
      [[$(12_000), 0.03078], [$(25_000), 0.03762], [$(50_000), 0.03819], [Infinity, 0.03876]],
      [[$(21_600), 0.03078], [$(45_000), 0.03762], [$(90_000), 0.03819], [Infinity, 0.03876]],
      [[$(12_000), 0.03078], [$(25_000), 0.03762], [$(50_000), 0.03819], [Infinity, 0.03876]],
      [[$(14_400), 0.03078], [$(30_000), 0.03762], [$(60_000), 0.03819], [Infinity, 0.03876]],
    ),
    schoolCredit: { amount: byStatus($(63), $(125), $(63), $(63)), incomeLimit: $(250_000) },
    schoolRateReduction: {
      incomeLimit: $(500_000),
      firstBand: byStatus($(12_000), $(21_600), $(12_000), $(14_400)),
      firstRate: 0.00171,
      base: byStatus($(21), $(37), $(21), $(25)),
      rate: 0.00228,
    },
  },
};

/** FY2026 budget: the first five New York rates drop 0.1 point for 2026 (and another 0.1 from 2027). */
const NY_2026: NyParams = {
  ...NY_2025,
  brackets: Object.fromEntries(
    Object.entries(NY_2025.brackets).map(([fs, rows]) => [fs, rows.map(([u, rate], i) => [u, i < 5 ? Math.round((rate - 0.001) * 10_000) / 10_000 : rate] as [number, number])]),
  ) as ByStatus<[number, number][]>,
};

export type TaxYearParams = { year: number; federal: FederalParams; ct: CtParams; ny: NyParams; notes: string[] };

export const TAX_YEARS: Record<number, TaxYearParams> = {
  2024: {
    year: 2024,
    federal: FED_2024,
    ct: CT_2025,
    ny: NY_2025,
    notes: [
      "Federal: Rev. Proc. 2023-34.",
      "Connecticut: the CT-1040 TCS tables in force since 2024 (the same as 2025's).",
      "New York State and City: IT-201/IT-203 rate schedules and tax computation worksheets (the same in 2024 and 2025).",
    ],
  },
  2025: {
    year: 2025,
    federal: FED_2025,
    ct: CT_2025,
    ny: NY_2025,
    notes: [
      "Federal: Rev. Proc. 2024-40 as amended by the One Big Beautiful Bill Act.",
      "Connecticut: 2025 CT-1040 TCS.",
      "New York State and City: 2025 IT-201/IT-203 rate schedules and tax computation worksheets.",
    ],
  },
  2026: {
    year: 2026,
    federal: FED_2026,
    ct: CT_2026,
    ny: NY_2026,
    notes: [
      "Federal: Rev. Proc. 2025-32 (2026 inflation adjustments incl. OBBBA changes).",
      "Connecticut: 2025 CT-1040 TCS tables (not inflation-indexed; 2026 forms are not out yet). CT child tax credit per 2026 sSB 6.",
      "New York: 2025 brackets with the FY2026 budget's 0.1-point cut to the first five rates (2026 forms are not out yet); New York City unchanged.",
    ],
  },
};

export function taxYearParams(year: number): TaxYearParams {
  const p = TAX_YEARS[year];
  if (!p) throw new Error(`No tax parameters for ${year}; supported: ${Object.keys(TAX_YEARS).join(", ")}`);
  return p;
}
