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
  {
    // eslint-config-next 16 brings react-hooks 7's React Compiler rules as errors. The
    // app doesn't use the React Compiler, and the code these flag works as written, so
    // they warn rather than fail lint until a cleanup pass rewrites those spots.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/purity": "warn",
    },
  },
]);
