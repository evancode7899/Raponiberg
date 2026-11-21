/**
 * The kind of care a service line is, from its procedure code: the public CPT ranges
 * (and HCPCS letters, and a hospital's 3-digit revenue codes). Rough on purpose: it groups
 * a year's claims into a few kinds of care, it doesn't price or judge them.
 */

export const CARE_KINDS = [
  "Office & telehealth visits",
  "Physical therapy & rehab",
  "Lab tests",
  "Imaging",
  "Eye care",
  "Mental health",
  "Vaccines & injections",
  "Surgery & procedures",
  "Anesthesia",
  "Hospital stay",
  "Equipment & supplies",
  "Other tests & treatments",
  "Dental exams & cleanings",
  "Dental X-rays",
  "Fillings & crowns",
  "Root canals",
  "Gum care",
  "Dentures, bridges & implants",
  "Oral surgery",
  "Orthodontics",
  "Other dental",
  "Eye exams",
  "Glasses: frames",
  "Glasses: lenses",
  "Contact lenses",
  "Other vision",
  "Other",
] as const;
export type CareKind = (typeof CARE_KINDS)[number];

/** Dental procedure codes (CDT, "D" and four digits), by their families. */
function dentalKind(code: string): CareKind {
  const n = Number(code.slice(1));
  if (n >= 200 && n <= 399) return "Dental X-rays";
  if (n < 2000) return "Dental exams & cleanings";
  if (n < 3000) return "Fillings & crowns";
  if (n < 4000) return "Root canals";
  if (n < 5000) return "Gum care";
  if (n < 7000) return "Dentures, bridges & implants";
  if (n < 8000) return "Oral surgery";
  if (n < 9000) return "Orthodontics";
  return "Other dental";
}

/** Vision codes: the routine exam (S0620/S0621) and the HCPCS V2 eyewear families. */
function visionKind(code: string): CareKind {
  if (/^S062[01]$/.test(code)) return "Eye exams";
  if (/^V20/.test(code)) return "Glasses: frames";
  if (/^V25/.test(code)) return "Contact lenses";
  if (/^V27(?!99)|^V2[1-4]|^V26/.test(code)) return "Glasses: lenses";
  return "Other vision";
}

export function careKind(code: string | null): CareKind {
  if (!code) return "Other";
  if (/^D\d{4}$/.test(code)) return dentalKind(code);
  if (/^V2\d{3}$|^S062[01]$/.test(code)) return visionKind(code);
  if (/^\d{3}$/.test(code)) return "Hospital stay";
  if (/^[AEKL]/.test(code)) return "Equipment & supplies";
  if (/^J/.test(code)) return "Vaccines & injections";
  if (/^G/.test(code)) return "Office & telehealth visits";
  if (!/^\d{4}[0-9A-Z]$/.test(code)) return "Other";
  const n = Number(code.slice(0, 4)) * 10 + (/\d$/.test(code) ? Number(code[4]) : 0);
  if (n >= 100 && n <= 1999) return "Anesthesia";
  if (n >= 10004 && n <= 69990) return "Surgery & procedures";
  if (n >= 70010 && n <= 79999) return "Imaging";
  if (n >= 80047 && n <= 89398) return "Lab tests";
  if (n >= 90281 && n <= 90756) return "Vaccines & injections";
  if (n >= 90785 && n <= 90899) return "Mental health";
  if (n >= 92002 && n <= 92499) return "Eye care";
  if (n >= 97010 && n <= 97799) return "Physical therapy & rehab";
  if ((n >= 98000 && n <= 98016) || (n >= 99202 && n <= 99499)) return "Office & telehealth visits";
  if (n >= 90900 && n <= 99199) return "Other tests & treatments";
  return "Other";
}

/** Whether a code counts toward a limit's codes (prefixes) and isn't one it leaves out. */
export function codeCounts(code: string | null, prefixes: readonly string[], except: readonly string[] = []): boolean {
  return !!code && prefixes.some((p) => code.startsWith(p)) && !except.some((p) => code.startsWith(p));
}
