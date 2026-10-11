/** Inline script source (keep keys in sync with `@/lib/preferences`). */
export const PREFERENCE_BOOTSTRAP_SCRIPT = `
(function(){
  try {
    var t = localStorage.getItem("pf-theme");
    if (t === "light" || t === "dark" || t === "bloomberg") {
      document.documentElement.setAttribute("data-theme", t);
    } else {
      document.documentElement.setAttribute("data-theme", "bloomberg");
    }
    var f = localStorage.getItem("pf-font-scale");
    if (f === "sm" || f === "md" || f === "lg") {
      document.documentElement.setAttribute("data-font-scale", f);
    } else {
      document.documentElement.setAttribute("data-font-scale", "md");
    }
  } catch (e) {}
})();
`.trim();
