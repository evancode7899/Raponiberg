export const STORAGE_THEME = "pf-theme";
export const STORAGE_FONT_SCALE = "pf-font-scale";
const STORAGE_IDLE_LOCK = "pf-idle-lock";
const STORAGE_HIDE_AMOUNTS = "pf-hide-amounts";
export const STORAGE_UP_DOWN = "pf-updown";
export const STORAGE_MOTION = "pf-motion";

/** Minutes without a key, click or scroll before the app locks itself; 0 is never. */
export const IDLE_LOCK_CHOICES = [0, 5, 15, 30, 60] as const;
export const PREFERENCE_CHANGED_EVENT = "pf:preference-changed";

const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(PREFERENCE_CHANGED_EVENT));
};

export function idleLockMinutes(): number {
  const n = Number(stored(STORAGE_IDLE_LOCK));
  return (IDLE_LOCK_CHOICES as readonly number[]).includes(n) ? n : 0;
}
export const setIdleLockMinutes = (n: number) => store(STORAGE_IDLE_LOCK, String(n));

/** Amounts blurred on screen, for someone looking over a shoulder. Nothing is hidden from the page itself. */
export const amountsHidden = () => stored(STORAGE_HIDE_AMOUNTS) === "1";
export function setAmountsHidden(on: boolean) {
  document.documentElement.toggleAttribute("data-hide-amounts", on);
  store(STORAGE_HIDE_AMOUNTS, on ? "1" : "0");
}

export type AppTheme = "light" | "dark" | "terminal";
export type FontScale = "sm" | "md" | "lg";

export const THEMES: AppTheme[] = ["light", "dark", "terminal"];
export const FONT_SCALES: FontScale[] = ["sm", "md", "lg"];

export function isAppTheme(v: string | null | undefined): v is AppTheme {
  return v === "light" || v === "dark" || v === "terminal";
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

/** Dispatched on window when the theme changes, so every theme control shows the current one. */
export const THEME_CHANGED_EVENT = "pf:theme-changed";

export function applyTheme(theme: AppTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_THEME, theme);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent<AppTheme>(THEME_CHANGED_EVENT, { detail: theme }));
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

/** How up and down are colored: the usual green and red, or blue and red, which color-blind eyes tell apart (deuteranopia, protanopia). */
export type UpDown = "standard" | "blue";
export const upDown = (): UpDown => (stored(STORAGE_UP_DOWN) === "blue" ? "blue" : "standard");
export function setUpDown(v: UpDown) {
  document.documentElement.setAttribute("data-updown", v);
  store(STORAGE_UP_DOWN, v);
}

/** Motion: as the computer's setting says, or none at all whatever it says (a drawer appears without sliding). */
export type Motion = "system" | "reduce";
export const motion = (): Motion => (stored(STORAGE_MOTION) === "reduce" ? "reduce" : "system");
export function setMotion(v: Motion) {
  document.documentElement.setAttribute("data-motion", v);
  store(STORAGE_MOTION, v);
}
