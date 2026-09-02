/**
 * Assert that no backend secret has reached the frontend, its environment, or its built bundle.
 *
 * Design.md decision 19 splits Weathra's credentials in two, and the split is only real if
 * something checks it:
 *
 * - **Public, and shipped to browsers on purpose** — the Supabase project URL, its public client
 *   key, and the backend's base URL. These carry no privilege beyond what Row Level Security and
 *   Supabase Auth already allow an anonymous or signed-in caller to do.
 * - **Backend secrets** — the Supabase service-role key, the database URLs, and the inference
 *   credential. The service-role key *bypasses Row Level Security entirely*, which is why the
 *   backend refuses it on a request path at all and why its presence anywhere near the frontend is
 *   the most serious configuration failure this project can have.
 *
 * **Three places are checked, and they fail for different reasons.**
 *
 * 1. **The environment files.** A secret in `.env.local` is one a developer's machine holds, and —
 *    with a `NEXT_PUBLIC_` prefix — one every visitor holds. Every `.env*` file is read, including
 *    the git-ignored local ones, because those are where a real key actually lands.
 * 2. **The source.** A hard-coded key in a component is in the bundle whatever the environment
 *    says. ESLint's `no-restricted-syntax` rule already forbids *reading* a non-public variable;
 *    this catches the literal that skips `process.env` altogether.
 * 3. **The built bundle**, when one exists. The authoritative check: Next.js inlines
 *    `NEXT_PUBLIC_` values at build time, so this is what a browser actually downloads. Pass
 *    `requireBundle` to make a missing build a failure rather than a note — CI does, after
 *    `npm run build`, so the gate can never quietly pass by having nothing to look at.
 *
 * **And the rule that catches the near-miss.** No variable whose name reads as a secret may carry
 * a `NEXT_PUBLIC_` prefix, because the prefix is the mechanism:
 * `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` is a configuration that *works*, and publishes a
 * bypass-everything credential to every visitor.
 *
 * The checker is a library rather than a script so its own behaviour can be tested: task 18.11
 * requires evidence that the check *fails* when a secret is deliberately introduced, which means
 * pointing it at a directory tree built for the purpose. `secret-containment.test.ts` does both —
 * it runs the check against this repository and against deliberately poisoned fixtures.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Variable names that name a backend secret. Compared upper-case, as substrings. */
export const SECRET_NAMES: readonly string[] = [
  "SERVICE_ROLE",
  "SERVICE_KEY",
  "DATABASE_URL",
  "OPENROUTER_API_KEY",
  "INFERENCE_API_KEY",
  "JWT_SECRET",
  "POSTGRES_PASSWORD",
  "DB_PASSWORD",
  "PRIVATE_KEY",
];

/**
 * The variables the frontend may hold. Anything else is reported as a warning rather than a
 * failure: a deployment may legitimately add an analytics id, and a check that failed on every
 * unfamiliar name would be edited into silence within a week. A name that reads as a secret is a
 * failure regardless of this list.
 */
export const PERMITTED_FRONTEND_NAMES: readonly string[] = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_API_BASE_URL",
  "NEXT_PUBLIC_APP_URL",
  "NODE_ENV",
  "NEXT_TELEMETRY_DISABLED",
];

/**
 * The shapes a real secret *value* takes, for the bundle scan where variable names are gone.
 *
 * A Supabase service-role key is a JWT whose payload declares `"role":"service_role"`, so the
 * pattern matches that claim — in the decoded form and in the base64url the token carries it as.
 * Matching the claim rather than the token's `eyJ` prefix is what makes this usable: the anon key
 * is also a JWT and is *meant* to be in the bundle, so a check that flagged every JWT would flag
 * the correct configuration.
 */
export const SECRET_VALUE_PATTERNS: readonly { readonly what: string; readonly pattern: RegExp }[] =
  [
    {
      what: "a Supabase service-role JWT",
      // The claim decoded, and the claim as base64url — in all three alignments, because base64
      // encodes three bytes at a time and the substring's encoding depends on how many bytes of
      // JSON precede it. Matching one alignment would miss the token for the sake of a `{`.
      pattern:
        /"role"\s*:\s*"service_role"|InJvbGUiOiJzZXJ2aWNlX3Jv|b2xlIjoic2VydmljZV9yb2|cm9sZSI6InNlcnZpY2Vfcm9/,
    },
    {
      what: "a PostgreSQL connection URL",
      pattern: /postgres(?:ql)?(?:\+[a-z]+)?:\/\/[^\s"'`]{8,}/i,
    },
    { what: "an OpenRouter API key", pattern: /sk-or-v1-[A-Za-z0-9]{16,}/ },
    { what: "an OpenAI-style API key", pattern: /sk-[A-Za-z0-9]{32,}/ },
    { what: "a private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  ];

/** One containment failure, carrying enough detail to fix it and no secret value in it. */
export interface Finding {
  /** Repository-relative path, with a line number where one is meaningful. */
  readonly where: string;
  /** What was found, in the words the fixer needs. */
  readonly what: string;
  /** Why it matters, and what to do. Never the offending value. */
  readonly detail: string;
}

/** What a run looked at, so a passing check can still say what it covered. */
export interface Scanned {
  readonly environmentFiles: readonly string[];
  readonly sourceFiles: number;
  readonly bundleFiles: number;
  readonly bundlePresent: boolean;
}

export interface ContainmentReport {
  readonly findings: readonly Finding[];
  /** Names outside the permitted list that are not secrets — worth a look, not a failure. */
  readonly warnings: readonly string[];
  readonly scanned: Scanned;
}

export interface CheckOptions {
  /** The frontend directory to check. */
  readonly root: string;
  /**
   * Treat a missing `.next` build as a failure. CI sets this after `npm run build`: the bundle is
   * the authoritative surface, and "there was nothing to scan" must not read as "nothing found".
   */
  readonly requireBundle?: boolean;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const BUNDLE_EXTENSIONS = [".js", ".mjs", ".json", ".html", ".txt", ".map"];

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".git",
]);

/**
 * The checker's own files, which quote secret shapes in order to recognise them.
 *
 * A narrow, named exemption rather than "skip all tests": a credential committed in a test file is
 * still a committed credential, so every other test stays in scope. The poisoned-fixture cases in
 * `secret-containment.test.ts` are what prove the patterns still fire.
 */
const SELF: readonly string[] = [
  join("scripts", "secret-containment.ts"),
  join("scripts", "secret-containment.test.ts"),
];

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_NAMES.some((secret) => upper.includes(secret));
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function walk(directory: string, skip: ReadonlySet<string>): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) {
      if (!skip.has(entry)) found.push(...walk(path, skip));
    } else {
      found.push(path);
    }
  }
  return found;
}

function environmentFilesIn(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(".env"))
    .filter((entry) => !entry.endsWith(".md") && !entry.endsWith(".ts"))
    .filter((entry) => {
      try {
        return statSync(join(root, entry)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((entry) => join(root, entry));
}

function checkEnvironment(root: string): {
  findings: Finding[];
  warnings: string[];
  files: string[];
} {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  const files = environmentFilesIn(root);

  for (const path of files) {
    const content = readText(path);
    if (content === null) continue;
    const shown = relative(root, path);

    content.split("\n").forEach((line, index) => {
      const where = `${shown}:${index + 1}`;
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return;

      const match = ASSIGNMENT.exec(line);
      if (match === null) return;
      const name = match[1] ?? "";
      const value = (match[2] ?? "").trim();

      if (name.startsWith("NEXT_PUBLIC_") && isSecretName(name.slice("NEXT_PUBLIC_".length))) {
        findings.push({
          where,
          what: "a secret carrying a NEXT_PUBLIC_ prefix",
          detail: `${name} would be inlined into every browser bundle. Backend secrets belong to the backend's environment.`,
        });
        return;
      }

      if (isSecretName(name)) {
        findings.push({
          where,
          what: "a backend secret in the frontend environment",
          detail: `${name} belongs to the backend only. Value not shown; rotate it if it was ever a real one.`,
        });
        return;
      }

      const shape = SECRET_VALUE_PATTERNS.find(({ pattern }) => value !== "" && pattern.test(value));
      if (shape !== undefined) {
        findings.push({
          where,
          what: `a value shaped like ${shape.what}`,
          detail: `${name} holds something that reads as a credential. Value not shown.`,
        });
        return;
      }

      if (!PERMITTED_FRONTEND_NAMES.includes(name)) {
        warnings.push(
          `${where}: ${name} is not on the permitted frontend list. If it is public by necessity, add it to PERMITTED_FRONTEND_NAMES with a reason.`,
        );
      }
    });
  }

  return { findings, warnings, files: files.map((path) => relative(root, path)) };
}

function checkSource(root: string): { findings: Finding[]; count: number } {
  const findings: Finding[] = [];
  let count = 0;

  for (const path of walk(root, SKIPPED_DIRECTORIES)) {
    const shown = relative(root, path);
    if (SELF.includes(shown)) continue;
    if (!SOURCE_EXTENSIONS.some((extension) => shown.endsWith(extension))) continue;
    if (shown === "package-lock.json") continue;

    const content = readText(path);
    if (content === null) continue;
    count += 1;

    for (const { what, pattern } of SECRET_VALUE_PATTERNS) {
      const found = pattern.exec(content);
      if (found !== null) {
        findings.push({
          where: `${shown}:${lineOf(content, found.index)}`,
          what: `a hard-coded value shaped like ${what}`,
          detail: "A credential in source is in the bundle whatever the environment says.",
        });
      }
    }

    for (const found of content.matchAll(/NEXT_PUBLIC_([A-Za-z0-9_]+)/g)) {
      const suffix = found[1] ?? "";
      if (isSecretName(suffix)) {
        findings.push({
          where: `${shown}:${lineOf(content, found.index)}`,
          what: "a secret referenced with a NEXT_PUBLIC_ prefix",
          detail: `NEXT_PUBLIC_${suffix} would ship to every browser.`,
        });
      }
    }
  }

  return { findings, count };
}

function checkBundle(
  root: string,
  requireBundle: boolean,
): { findings: Finding[]; count: number; present: boolean } {
  const findings: Finding[] = [];
  const build = join(root, ".next");

  if (!existsSync(build)) {
    if (requireBundle) {
      findings.push({
        where: ".next",
        what: "no built bundle to check",
        detail:
          "The bundle is the surface a browser actually receives. Run `npm run build` before this check; a missing build is not a pass.",
      });
    }
    return { findings, count: 0, present: false };
  }

  let count = 0;
  for (const path of walk(build, new Set(["cache"]))) {
    const shown = relative(root, path);
    if (!BUNDLE_EXTENSIONS.some((extension) => shown.endsWith(extension))) continue;

    const content = readText(path);
    if (content === null) continue;
    count += 1;

    const shape = SECRET_VALUE_PATTERNS.find(({ pattern }) => pattern.test(content));
    if (shape !== undefined) {
      findings.push({
        where: shown,
        what: `a value shaped like ${shape.what} in the built bundle`,
        detail: "This is what a browser downloads. Rotate the credential, then fix the build.",
      });
    }
  }

  return { findings, count, present: true };
}

/** Run every containment check against one frontend directory. */
export function checkSecretContainment(options: CheckOptions): ContainmentReport {
  const { root, requireBundle = false } = options;

  const environment = checkEnvironment(root);
  const source = checkSource(root);
  const bundle = checkBundle(root, requireBundle);

  return {
    findings: [...environment.findings, ...source.findings, ...bundle.findings],
    warnings: environment.warnings,
    scanned: {
      environmentFiles: environment.files,
      sourceFiles: source.count,
      bundleFiles: bundle.count,
      bundlePresent: bundle.present,
    },
  };
}

/** The findings as text, for a failure message a human can act on. */
export function describeFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return "no findings";
  return findings.map(({ where, what, detail }) => `${where}: ${what} — ${detail}`).join("\n");
}
