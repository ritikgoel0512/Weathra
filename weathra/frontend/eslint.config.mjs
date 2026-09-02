import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // A server-side secret must never be read in frontend code. Only NEXT_PUBLIC_* is legal,
      // and the CI secret-exposure check asserts the same boundary on the built bundle.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/^(?!NEXT_PUBLIC_|NODE_ENV$)/]",
          message:
            "Frontend code may read only NEXT_PUBLIC_* configuration. Server-side secrets belong to the backend.",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "tests/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // frontend/scripts holds Node tooling — the secret-containment check and its tests. Nothing
    // here is imported by the application, so nothing here reaches a browser bundle, and the
    // NEXT_PUBLIC_-only rule is about what ships: these files read their own flags the way any
    // Node script does. They may still hold no credential of their own — the containment check
    // scans this directory along with the rest of the frontend.
    files: ["scripts/**"],
    rules: { "no-restricted-syntax": "off" },
  },
);
