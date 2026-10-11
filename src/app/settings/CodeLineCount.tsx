"use client";

import type { Api } from "@/components/ledger/useApi";
import { useEffect, useState } from "react";

/** "x lines of code": a small note on the app's own size. Shows nothing if the count fails. */
export function CodeLineCount({ api }: { api: Api }) {
  const [lines, setLines] = useState<number | null>(null);
  useEffect(() => {
    api
      .call<{ lines: number }>("/api/system/code-lines")
      .then((r) => setLines(r.lines))
      .catch(() => {});
  }, [api]);
  if (lines == null) return null;
  return <p className="num text-center text-xs text-muted">{lines.toLocaleString()} lines of code</p>;
}
