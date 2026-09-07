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
      /*
       * The task 21.8 manual-pass harness's working directory, declared gitignored in
       * `.gitignore`. It holds the serve scripts and the front proxy the browser-based review
       * environment runs on — Node tooling, like `scripts/`, not application code, and subject to
       * none of the rules below (it reads the harness's own non-public environment by design).
       */
      ".manual-pass/**",
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
    // Node tooling, not application code: `scripts/` holds the secret-containment check, and the
    // Playwright config and its end-to-end harness drive a built application from outside it.
    // Nothing here is imported by the application, so nothing here reaches a browser bundle, and
    // the NEXT_PUBLIC_-only rule is about what ships: these files read their own flags the way any
    // Node script does. They may still hold no credential of their own — the containment check
    // scans these directories along with the rest of the frontend.
    files: [
      "scripts/**",
      "playwright.config.ts",
      "tests/e2e/**",
      /*
       * `lib/images/provider.server.ts` and the route handler that calls it are the one part of
       * this application that runs *only* on the server and legitimately reads a secret: the city
       * image provider's API key. The rule below exists to stop a secret reaching the browser
       * bundle, and these files do not.
       *
       * **What actually enforces that, precisely.** `provider.server.ts` does *not* use Next's
       * `import "server-only"` — that package is not a dependency of this project, and adding one
       * to buy a guard the file can write in four lines is not a trade worth making. It calls its
       * own `assertServer()` at module load, which throws the moment the module is evaluated
       * anywhere with a `window`. The difference is worth stating rather than glossing: an
       * accidental import from a client component fails at *runtime*, on first render, not at
       * build time. That is weaker than `server-only` and it is what is in place.
       *
       * Two checks sit behind it and do not depend on this exemption being honoured: the bundle
       * assertion in `scripts/secret-containment.test.ts` fails the build if either key's value
       * appears in client output, and `lib/images/provider.test.ts` asserts no file other than the
       * server module and its own test so much as names either variable.
       */
      "lib/images/provider.server.ts",
      "lib/images/provider.test.ts",
      "app/api/location-image/route.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
);
