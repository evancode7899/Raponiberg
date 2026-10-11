import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  globalIgnores([".next/**", ".next-*/**", "node_modules/**", ".claude/**", "data/**", "next-env.d.ts"]),
  ...nextVitals,
  ...nextTs,
  {
    // A leading underscore marks a value left unused on purpose.
    rules: { "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }] },
  },
]);
