import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import type { HomeBudgetInputs } from "@/lib/home-budget/homeBudgetModel";
import { readPageInputs } from "@/lib/pageInputs";
import { buyDefaults } from "@/lib/scenarios/facts";
import { readScenarios, writeScenarios } from "@/lib/scenarios/store";
import type { BuyHome, ScenarioFile } from "@/lib/scenarios/types";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export type ScenariosFileBody = { file: ScenarioFile; buy: Omit<BuyHome, "at"> };

/** The saved scenarios (data/scenarios.json), and a purchase's starting figures from the Home budget page's inputs. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body: ScenariosFileBody = { file: readScenarios(), buy: buyDefaults(readPageInputs("pf-home-budget-inputs") as Partial<HomeBudgetInputs> | null) };
  return NextResponse.json(body);
}

/** Body: the whole scenario file; replaces it. */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected the scenario file" }, { status: 400 });
  try {
    // Saved as the owner edits (like the calculators' inputs), so not in the audit trail.
    return NextResponse.json(writeScenarios(body));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 400 });
  }
}
