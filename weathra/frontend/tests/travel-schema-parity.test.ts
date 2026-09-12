/**
 * The capture harness and production must answer Travel with the *same contract*.
 *
 * Travel Intelligence was graded complete from `capture/15-travel-1440.png`, and that picture was
 * taken against a fixture answering `POST /weather/comparison` with `mode: "locations"` — two
 * cities, scored on raw temperature, carrying `basis`, `weights`, `retrieved_at`, a correlation and
 * a data density. The Travel screen sends a single `location` and a `days` horizon, which the real
 * service answers from `compare_days`: ISO-dated candidates, scores on 0–1, the two cross-place
 * statistics `null`, and none of those three extra fields, which `ComparisonResult` forbids. So the
 * screenshot showed a screen fed a shape production never returns, and every region built on it was
 * evidence of nothing.
 *
 * A fixture may hold whatever deterministic *values* a reproducible screenshot needs. It may not
 * offer *capabilities* the contract does not, or withhold ones it does. This test pins that by
 * running the real stub and checking its answers against `backend/openapi.json` — the same document
 * `lib/api/schema.ts` is generated from, so both consumers are held to one view model.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "e2e", "weathra-api-stub.mjs");
const CONTRACT = join(HERE, "..", "..", "backend", "openapi.json");

const PORT = 54399;
const BASE = `http://127.0.0.1:${PORT}`;

interface Schema {
  readonly $ref?: string;
  readonly type?: string;
  readonly required?: string[];
  readonly properties?: Record<string, Schema>;
  readonly additionalProperties?: boolean | Schema;
  readonly anyOf?: Schema[];
  readonly enum?: unknown[];
  readonly items?: Schema;
}

const document = JSON.parse(readFileSync(CONTRACT, "utf8")) as {
  components: { schemas: Record<string, Schema> };
};

function component(name: string): Schema {
  const found = document.components.schemas[name];
  if (found === undefined) throw new Error(`openapi.json declares no ${name}`);
  return found;
}

/** A `$ref` resolved to the component it names; anything else returned unchanged. */
function resolve(schema: Schema): Schema {
  const ref = schema.$ref;
  if (ref === undefined) return schema;
  return component(ref.replace("#/components/schemas/", ""));
}

/**
 * Every complaint a payload earns against a schema: a missing required field, or a field the schema
 * does not declare.
 *
 * Deliberately not a full JSON-Schema implementation — types and formats are the generated client's
 * business. This checks the two properties a fixture drifts on: answering with less than the
 * contract promises, and answering with more than it allows.
 */
function violations(value: unknown, schema: Schema, path = "$"): string[] {
  const resolved = resolve(schema);

  if (resolved.anyOf) {
    // A nullable field is `anyOf: [T, null]`; null satisfies it and anything else must satisfy a
    // branch. Reported against the first non-null branch, which is the informative one.
    if (value === null) return [];
    const branches = resolved.anyOf.filter((branch) => branch.type !== "null");
    if (branches.length === 0) return [];
    const results = branches.map((branch) => violations(value, branch, path));
    return results.some((found) => found.length === 0) ? [] : (results[0] as string[]);
  }

  if (resolved.type === "array" && Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      resolved.items ? violations(entry, resolved.items, `${path}[${index}]`) : [],
    );
  }

  if (resolved.properties === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];

  const record = value as Record<string, unknown>;
  const found: string[] = [];

  for (const name of resolved.required ?? []) {
    if (!(name in record)) found.push(`${path}.${name} is required by the contract and absent`);
  }

  const declared = new Set(Object.keys(resolved.properties));
  if (resolved.additionalProperties === false) {
    for (const name of Object.keys(record)) {
      if (!declared.has(name)) {
        found.push(`${path}.${name} is not a field the contract declares`);
      }
    }
  }

  for (const [name, child] of Object.entries(resolved.properties)) {
    if (name in record && record[name] !== undefined) {
      found.push(...violations(record[name], child, `${path}.${name}`));
    }
  }

  return found;
}

let stub: ChildProcess | null = null;

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/control/requests`);
    return response.ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  stub = spawn(process.execPath, [STUB], {
    env: { ...process.env, WEATHRA_API_STUB_PORT: String(PORT) },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await reachable()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("the api stub did not start");
}, 20_000);

afterAll(() => {
  stub?.kill();
});

/** The request the Travel screen actually issues: a destination and two dates. */
const TRIP = {
  destination: "Barcelona, Spain",
  origin: "Berlin, Germany",
  start: "2026-09-14",
  end: "2026-09-18",
};

describe("the Travel fixture answers Travel's own request", () => {
  async function analyse() {
    const response = await fetch(`${BASE}/api/v1/travel/intelligence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(TRIP),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("returns a trip analysis the contract would accept", async () => {
    const { status, body } = await analyse();
    expect(status).toBe(200);
    expect(violations(body, component("TravelIntelligence"))).toEqual([]);
  });

  it("answers the whole screen from one call", async () => {
    const { body } = await analyse();

    /*
     * Every region the screen draws comes from this one response. The fixture may not be narrower
     * than the contract: a stub missing a section hides a populated region rather than inventing
     * one, and is still a fixture that disagrees with the route.
     */
    for (const section of [
      "trip",
      "hero_summary",
      "viability",
      "metrics",
      "daily_outlook",
      "packing_strategy",
      "temporal_comparison",
      "synthesis",
      "evidence",
    ]) {
      expect(body[section]).toBeTruthy();
    }
  });

  it("scores viability on 0-100 and discloses whose heuristic it is", async () => {
    const { body } = await analyse();
    const viability = body.viability as { score: number; state: string; disclosure: string };

    expect(viability.score).toBeGreaterThanOrEqual(0);
    expect(viability.score).toBeLessThanOrEqual(100);
    expect(["Excellent", "Good", "Mixed", "Poor"]).toContain(viability.state);
    expect(viability.disclosure).toMatch(/Weathra's own heuristic/);
  });

  it("names no metric Weathra has no data for", async () => {
    const { body } = await analyse();
    const metrics = body.metrics as { label: string; method: string }[];
    const text = metrics.map((m) => `${m.label} ${m.method}`).join(" ");

    // The artifact's "Flight Stability" implies aviation data Weathra does not hold.
    expect(text).not.toMatch(/flight stability|turbulence|airline operations/i);
  });

  it("reports a section it could not produce rather than filling it in", async () => {
    const { body } = await analyse();
    const failures = (body.partial_failures ?? []) as { section: string; reason: string }[];

    // The archive could not answer, so the band is null and the reason is stated. A fixture that
    // returned a happy baseline here would photograph a screen production cannot produce.
    expect(body.historical_baseline ?? null).toBeNull();
    expect(failures.some((failure) => failure.section === "historical_baseline")).toBe(true);
  });

  it("never fabricates a forecast change", async () => {
    const { body } = await analyse();
    expect(body.forecast_changes ?? null).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/convergence|vector alignment|sync delta/i);
  });

  it("carries the daily fields the outlook cards read", async () => {
    const { body } = await analyse();
    const days = body.daily_outlook as Record<string, unknown>[];

    expect(days.length).toBeGreaterThan(0);
    for (const key of [
      "local_date",
      "weekday",
      "condition_code",
      "temperature_max",
      "temperature_min",
      "precipitation_sum",
      "viability",
    ]) {
      expect(Object.keys(days[0] as object)).toContain(key);
    }
  });
});
