"use client";

import { derivedDescriptor, type DerivedPage, type DerivedTarget } from "@/lib/book/derived/types";
import { splitSaid, type Amount } from "@/lib/book/said";
import { Fragment } from "react";
import { ProofValue } from "./ProofValue";

/** An amount in a sentence as a figure of `page`'s derived list (lib/book/said.ts). */
export const amountTarget = (page: DerivedPage, a: Amount): DerivedTarget =>
  "cents" in a.value ? { descriptor: derivedDescriptor(page, { figure: "amount", key: a.key }), shownCents: a.value.cents } : { descriptor: derivedDescriptor(page, { figure: "amount", key: a.key }), shownCents: null, shown: a.value };

/**
 * A sentence a check or the tax engine wrote, each amount it recorded drawn as its figure
 * (opening its proof); the words around them stay words. `field` picks the sentence's
 * amounts from its owner's list (a finding's title, detail or fix).
 */
export function Said({ text, amounts, field, page }: { text: string; amounts?: readonly Amount[]; field: string; page: DerivedPage }) {
  if (!amounts?.length) return <>{text}</>;
  return (
    <>
      {splitSaid(text, amounts, field).map((p, i) => (typeof p === "string" ? <Fragment key={i}>{p}</Fragment> : <ProofValue key={i} proof={amountTarget(page, p)}>{p.text}</ProofValue>))}
    </>
  );
}
