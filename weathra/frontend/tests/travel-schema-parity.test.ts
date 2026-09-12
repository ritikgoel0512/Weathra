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

/** The request the Travel screen actually issues, with the screen's own defaults. */
const TRAVEL_RANKING = {
  criterion: "outdoor_suitability",
  location: "Berlin, Germany",
  days: 7,
};

describe("the Travel fixture answers Travel's own request", () => {
  it("returns a ranking the contract would accept", async () => {
    const response = await fetch(`${BASE}/api/v1/weather/comparison`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(TRAVEL_RANKING),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(violations(body, component("ComparisonResult"))).toEqual([]);
  });

  it("ranks days, because that is what a single location and a horizon ask for", async () => {
    const response = await fetch(`${BASE}/api/v1/weather/comparison`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(TRAVEL_RANKING),
    });
    const body = (await response.json()) as { mode: string; candidates: { label: string }[] };

    expect(body.mode).toBe("days");
    // `compare_days` labels a candidate with its ISO date. The screen is responsible for speaking
    // that; the fixture must not pre-format it, or the bug that put a raw date in front of a
    // customer becomes invisible to every capture.
    for (const candidate of body.candidates) {
      expect(candidate.label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("leaves the cross-place statistics unset, as a day ranking does", async () => {
    const response = await fetch(`${BASE}/api/v1/weather/comparison`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(TRAVEL_RANKING),
    });
    const body = (await response.json()) as Record<string, unknown>;

    // Pearson's r describes a pair of places and density counts instants every candidate reported.
    // Neither means anything across the days of one place, and `compare_days` returns neither.
    expect(body.correlation ?? null).toBeNull();
    expect(body.data_density ?? null).toBeNull();
  });

  it("scores on the 0–1 scale the criterion produces", async () => {
    const response = await fetch(`${BASE}/api/v1/weather/comparison`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(TRAVEL_RANKING),
    });
    const body = (await response.json()) as { candidates: { score: number }[] };

    for (const candidate of body.candidates) {
      expect(candidate.score).toBeGreaterThan(0);
      expect(candidate.score).toBeLessThanOrEqual(1);
    }
  });

  it("supports each day with the statistics the ranking actually applies", async () => {
    const response = await fetch(`${BASE}/api/v1/weather/comparison`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(TRAVEL_RANKING),
    });
    const body = (await response.json()) as {
      candidates: { supporting: { measure: string }[] }[];
    };

    for (const candidate of body.candidates) {
      const measures = candidate.supporting.map((entry) => entry.measure);
      expect(measures).toEqual(["temperature_mean", "precipitation_sum", "wind_speed_max"]);
    }
  });
});

describe("the Travel fixture answers Travel's other reads", () => {
  it("places a window still ahead against the baseline from the forecast side", async () => {
    const response = await fetch(
      `${BASE}/api/v1/weather/history/baseline/comparison?latitude=52.52&longitude=13.405&start=2026-09-04&end=2026-09-10&years=5&measure=temperature_mean`,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(violations(body, component("BaselineComparison"))).toEqual([]);

    // The archive cannot be asked about days that have not happened, so the value is the
    // forecast's and the result says which side is uncertain.
    expect(body.observed_data_class).toBe("forecast");
    expect(body.forecast_side_caveat).toBeTruthy();
  });

  it("still answers a past window as observation on both sides", async () => {
    const response = await fetch(
      `${BASE}/api/v1/weather/history/baseline/comparison?latitude=52.52&longitude=13.405&start=2025-09-01&end=2025-09-07&years=5&measure=temperature_mean`,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.observed_data_class).toBe("historical_observation");
    expect(body.forecast_side_caveat ?? null).toBeNull();
  });

  it("carries the daily measures the outlook cards and the metric row read", async () => {
    const response = await fetch(
      `${BASE}/api/v1/weather/forecast?latitude=52.52&longitude=13.405&days=7`,
    );
    const body = (await response.json()) as {
      daily: { entries: { values: Record<string, number | null> }[] };
    };

    const first = body.daily.entries[0]?.values ?? {};
    // The condition glyph, the high and low, and the fourth metric card each read one of these.
    for (const measure of [
      "weather_code_dominant",
      "temperature_max",
      "temperature_min",
      "precipitation_probability_max",
      "uv_index_max",
    ]) {
      expect(Object.keys(first)).toContain(measure);
    }
  });
});
