/**
 * Home dashboard quote block (stable copy).
 */
export function homeEncouragement(_opts: {
  netWorthDeltaCents: number | null;
}): { headline: string; body: string } {
  return {
    headline:
      "Money's only something you need in case you don't die tomorrow",
    body: "Greed, for lack of a better word, is good.",
  };
}
