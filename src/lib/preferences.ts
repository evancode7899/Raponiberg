export const STORAGE_THEME = "pf-theme";
export const STORAGE_FONT_SCALE = "pf-font-scale";

export type AppTheme = "light" | "dark" | "bloomberg";
export type FontScale = "sm" | "md" | "lg";

export const THEMES: AppTheme[] = ["light", "dark", "bloomberg"];
export const FONT_SCALES: FontScale[] = ["sm", "md", "lg"];

export function isAppTheme(v: string | null | undefined): v is AppTheme {
  return v === "light" || v === "dark" || v === "bloomberg";
}

export function isFontScale(v: string | null | undefined): v is FontScale {
  return v === "sm" || v === "md" || v === "lg";
}

/** Multiplier vs legacy md=1; sm/lg scale proportionally (same ratios as 0.875/1/1.125). */
const FONT_SCALE_CSS: Record<FontScale, string> = {
  sm: "0.9296875",
  md: "1.0625",
  lg: "1.1953125",
};

export function fontScaleToCss(v: FontScale): string {
  return FONT_SCALE_CSS[v];
}

export function applyTheme(theme: AppTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_THEME, theme);
  } catch {
    /* ignore */
  }
}

export function applyFontScale(scale: FontScale): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-font-scale", scale);
  try {
    localStorage.setItem(STORAGE_FONT_SCALE, scale);
  } catch {
    /* ignore */
  }
}
