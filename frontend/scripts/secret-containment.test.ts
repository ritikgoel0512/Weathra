/**
 * Task 18.11: the frontend holds no backend secret, and the check that says so actually fails when
 * one is introduced.
 *
 * Two halves, and the second is the point. Any check passes on a clean tree — including a check
 * that looks at nothing. So this file runs the real check against this repository *and* against
 * trees built to be caught, one per way a secret can arrive: named in the environment, prefixed
 * with `NEXT_PUBLIC_`, hard-coded in a component, or already inlined into the built bundle.
 *
 * The credential-shaped strings below are fabricated and belong to nobody. They live here rather
 * than in a fixture file so the thing being detected sits beside the assertion that detects it;
 * `secret-containment.ts` exempts exactly these two files from the source scan, and every other
 * file in the repository — tests included — stays in scope.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { checkSecretContainment, describeFindings } from "./secret-containment";

/**
 * This file lives in `frontend/scripts`, so the frontend root is one level up.
 *
 * Resolved through `fileURLToPath` rather than `new URL("..", import.meta.url).pathname`, which
 * Vite rewrites to a `/@fs/...` asset path — a directory that does not exist. The check then found
 * nothing and reported no findings, which is the precise way a containment gate passes while
 * measuring nothing. That is why the assertions below name what was scanned, not only what was
 * found.
 */
const FRONTEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A service-role key is a JWT whose payload declares `"role":"service_role"`. This is a real JWT
 * shape signed with nothing, so it is detected for the right reason: the claim, not the prefix.
 */
const FAKE_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  // {"role":"service_role","iss":"supabase"}
  "eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ." +
  "not-a-real-signature";

const FAKE_DATABASE_URL = "postgresql://weathra:hunter2@db.example.supabase.co:5432/postgres";

const FAKE_INFERENCE_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

/** A minimally valid frontend tree: one environment file holding only public configuration. */
function cleanTree(): string {
  const root = mkdtempSync(join(tmpdir(), "weathra-containment-"));
  writeFileSync(
    join(root, ".env.local"),
    [
      "NEXT_PUBLIC_SUPABASE_URL=https://project.supabase.co",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=public-anon-key",
      "NEXT_PUBLIC_API_BASE_URL=http://localhost:8000",
      "",
    ].join("\n"),
  );
  return root;
}

const created: string[] = [];

function tree(): string {
  const root = cleanTree();
  created.push(root);
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    const root = created.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("this repository", () => {
  /**
   * The gate CI runs. `requireBundle` follows the environment so one command serves both roles:
   * `npm run test` checks the environment and the source, and `npm run check:secrets` — run after
   * `npm run build` — additionally requires the bundle to exist and be clean. A missing build must
   * never read as a pass, which is why its absence is a finding rather than a skip.
   */
  const requireBundle = process.env.WEATHRA_REQUIRE_BUNDLE === "1";

  it("keeps every backend secret out of the frontend", () => {
    const report = checkSecretContainment({ root: FRONTEND_ROOT, requireBundle });

    expect(describeFindings(report.findings)).toBe("no findings");
    expect(report.scanned.environmentFiles).toContain(".env.example");
    expect(report.scanned.sourceFiles).toBeGreaterThan(0);
    if (requireBundle) {
      expect(report.scanned.bundlePresent).toBe(true);
      expect(report.scanned.bundleFiles).toBeGreaterThan(0);
    }
  });

  it("holds only public configuration in .env.example, with no unexplained names", () => {
    const report = checkSecretContainment({ root: FRONTEND_ROOT });
    expect(report.warnings).toEqual([]);
  });
});

describe("a secret deliberately introduced into the frontend environment", () => {
  it("is caught when the service-role key is named outright", () => {
    const root = tree();
    writeFileSync(
      join(root, ".env.local"),
      `SUPABASE_SERVICE_ROLE_KEY=${FAKE_SERVICE_ROLE_KEY}\n`,
    );

    const report = checkSecretContainment({ root });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.what).toBe("a backend secret in the frontend environment");
    expect(report.findings[0]?.where).toBe(".env.local:1");
  });

  it("is caught when it carries a NEXT_PUBLIC_ prefix, and says why that is worse", () => {
    const root = tree();
    writeFileSync(
      join(root, ".env.local"),
      `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=${FAKE_SERVICE_ROLE_KEY}\n`,
    );

    const report = checkSecretContainment({ root });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.what).toBe("a secret carrying a NEXT_PUBLIC_ prefix");
    expect(report.findings[0]?.detail).toContain("inlined into every browser bundle");
  });

  it("is caught when a database URL is added", () => {
    const root = tree();
    writeFileSync(join(root, ".env.production"), `DATABASE_URL=${FAKE_DATABASE_URL}\n`);

    const report = checkSecretContainment({ root });

    expect(report.findings.map(({ where }) => where)).toEqual([".env.production:1"]);
  });

  it("is caught by its value even under an innocuous name", () => {
    const root = tree();
    writeFileSync(join(root, ".env.local"), `NEXT_PUBLIC_BACKEND=${FAKE_DATABASE_URL}\n`);

    const report = checkSecretContainment({ root });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.what).toBe("a value shaped like a PostgreSQL connection URL");
  });

  it("never repeats the offending value in its own output", () => {
    const root = tree();
    writeFileSync(
      join(root, ".env.local"),
      `SUPABASE_SERVICE_ROLE_KEY=${FAKE_SERVICE_ROLE_KEY}\nDATABASE_URL=${FAKE_DATABASE_URL}\n`,
    );

    const report = checkSecretContainment({ root });
    const output = describeFindings(report.findings);

    expect(report.findings).toHaveLength(2);
    expect(output).not.toContain(FAKE_SERVICE_ROLE_KEY);
    expect(output).not.toContain(FAKE_DATABASE_URL);
    expect(output).not.toContain("hunter2");
  });

  it("reports a name it does not recognise without failing on it", () => {
    const root = tree();
    writeFileSync(join(root, ".env.local"), "NEXT_PUBLIC_PLAUSIBLE_DOMAIN=weathra.app\n");

    const report = checkSecretContainment({ root });

    expect(report.findings).toEqual([]);
    expect(report.warnings.join("\n")).toContain("NEXT_PUBLIC_PLAUSIBLE_DOMAIN");
  });

  it("ignores a commented-out line, which configures nothing", () => {
    const root = tree();
    writeFileSync(
      join(root, ".env.local"),
      "# Never add SUPABASE_SERVICE_ROLE_KEY here — it bypasses Row Level Security.\n",
    );

    expect(checkSecretContainment({ root }).findings).toEqual([]);
  });
});

describe("a secret hard-coded in frontend source", () => {
  it("is caught even though the environment is clean", () => {
    const root = tree();
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(
      join(root, "lib", "client.ts"),
      `export const key = "${FAKE_SERVICE_ROLE_KEY}";\n`,
    );

    const report = checkSecretContainment({ root });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.what).toContain("hard-coded");
    expect(report.findings[0]?.where).toBe(join("lib", "client.ts") + ":1");
  });

  it("is caught when source reads a NEXT_PUBLIC_-prefixed secret", () => {
    const root = tree();
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(
      join(root, "lib", "client.ts"),
      "const key = process.env.NEXT_PUBLIC_SERVICE_ROLE_KEY;\nexport default key;\n",
    );

    const report = checkSecretContainment({ root });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.what).toBe("a secret referenced with a NEXT_PUBLIC_ prefix");
  });

  it("does not scan node_modules, which the frontend does not author", () => {
    const root = tree();
    mkdirSync(join(root, "node_modules", "pg"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "pg", "index.js"),
      `const example = "${FAKE_DATABASE_URL}";\n`,
    );

    expect(checkSecretContainment({ root }).findings).toEqual([]);
  });
});

describe("a secret inlined into the built bundle", () => {
  function build(root: string, chunk: string): void {
    mkdirSync(join(root, ".next", "static", "chunks"), { recursive: true });
    writeFileSync(join(root, ".next", "static", "chunks", "main-abc123.js"), chunk);
  }

  it("is caught in the chunk a browser downloads", () => {
    const root = tree();
    build(root, `(()=>{const k="${FAKE_INFERENCE_KEY}";console.log(k)})();`);

    const report = checkSecretContainment({ root });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.what).toContain("in the built bundle");
    expect(report.findings[0]?.detail).toContain("Rotate the credential");
  });

  it("passes on a bundle carrying only the public client key", () => {
    const root = tree();
    build(root, '(()=>{const url="https://project.supabase.co",key="public-anon-key";})();');

    const report = checkSecretContainment({ root, requireBundle: true });

    expect(report.findings).toEqual([]);
    expect(report.scanned.bundlePresent).toBe(true);
  });

  it("ignores the build cache, which no browser receives", () => {
    const root = tree();
    mkdirSync(join(root, ".next", "cache", "webpack"), { recursive: true });
    writeFileSync(
      join(root, ".next", "cache", "webpack", "0.pack.js"),
      `const example = "${FAKE_DATABASE_URL}";\n`,
    );

    expect(checkSecretContainment({ root }).findings).toEqual([]);
  });

  it("treats a missing build as a failure when the bundle is required", () => {
    const root = tree();

    expect(checkSecretContainment({ root }).findings).toEqual([]);

    const required = checkSecretContainment({ root, requireBundle: true });
    expect(required.findings).toHaveLength(1);
    expect(required.findings[0]?.what).toBe("no built bundle to check");
    expect(required.scanned.bundlePresent).toBe(false);
  });
});
