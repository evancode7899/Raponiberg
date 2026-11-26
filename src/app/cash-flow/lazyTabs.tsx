"use client";

import { Loading } from "@/components/ui/kit";
import dynamic from "next/dynamic";

/**
 * The Cash flow tabs past the first, each loaded when it's opened rather than with the page:
 * the page's first load carries only what the Overview draws (item 62: speed). A tab still
 * loading shows the same still skeleton as data still loading.
 */
const opts = { loading: () => <Loading /> };
export const SpendingTab = dynamic(() => import("./SpendingTab").then((m) => m.SpendingTab), opts);
export const TrendsTab = dynamic(() => import("./TrendsTab").then((m) => m.TrendsTab), opts);
export const PatternsTab = dynamic(() => import("./PatternsTab").then((m) => m.PatternsTab), opts);
export const YoyTab = dynamic(() => import("./YoyTab").then((m) => m.YoyTab), opts);
export const MerchantsTab = dynamic(() => import("./MerchantsTab").then((m) => m.MerchantsTab), opts);
export const RecurringTab = dynamic(() => import("./RecurringTab").then((m) => m.RecurringTab), opts);
export const BudgetTab = dynamic(() => import("./BudgetTab").then((m) => m.BudgetTab), opts);
export const IncomeTab = dynamic(() => import("./IncomeTab").then((m) => m.IncomeTab), opts);
