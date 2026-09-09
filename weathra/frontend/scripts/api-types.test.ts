// @vitest-environment node

/**
 * The generated types match the backend's contract — and the generator itself behaves.
 *
 * The first half is drift detection: `lib/api/schema.ts` is regenerated from the committed
 * `backend/openapi.json` and compared to what is on disk. A backend change that alters the wire
 * format fails here until `npm run api:types` is run, so the frontend's types can never quietly
 * describe an API the backend stopped serving. (`backend/tests/test_openapi_snapshot.py` holds up
 * the other end: the committed document matches the running application.)
 *
 * The second half tests the generator on small documents, because a generator that mis-renders a
 * nullable field would produce types that compile and lie.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateApiTypes, renderType, type OpenApiDocument } from "./api-types";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = join(HERE, "..", "..", "backend", "openapi.json");
const GENERATED = join(HERE, "..", "lib", "api", "schema.ts");

function contract(): OpenApiDocument {
  return JSON.parse(readFileSync(CONTRACT, "utf8")) as OpenApiDocument;
}

describe("the generated contract", () => {
  it("matches the backend's committed OpenAPI document", async () => {
    // `vitest -u` (which `npm run api:types` runs) writes the file; a plain run compares.
    await expect(generateApiTypes(contract())).toMatchFileSnapshot(GENERATED);
  });

  it("covers every operation the backend serves", () => {
    const document = contract();
    const served = Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
    );

    const generated = readFileSync(GENERATED, "utf8");
    for (const operation of served) {
      const [method, path] = operation.split(" ");
      expect(generated, operation).toContain(`path: ${JSON.stringify(path)}`);
      expect(generated).toContain(`method: ${JSON.stringify(method)}`);
    }
  });

  it("marks the protected operations as needing a token", () => {
    const generated = readFileSync(GENERATED, "utf8");
    const document = contract();

    const protectedCount = Object.values(document.paths)
      .flatMap((operations) => Object.values(operations))
      .filter((operation) => (operation.security ?? []).length > 0).length;

    expect(protectedCount).toBeGreaterThan(0);
    expect(generated.match(/requiresToken: true/g) ?? []).toHaveLength(protectedCount);
  });
});

describe("the generator", () => {
  it("renders a nullable field as a union with null, not as optional", () => {
    // These mean different things on the wire: the backend *sends* `note: null`, it does not omit
    // the key. A generator that collapsed the two would let a screen skip a null check.
    expect(renderType({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe("string | null");
  });

  it("renders an enum as a union of literals", () => {
    expect(renderType({ enum: ["metric", "imperial"], type: "string" })).toBe(
      '"metric" | "imperial"',
    );
  });

  it("renders a constant as its literal", () => {
    expect(renderType({ const: "forecast" })).toBe('"forecast"');
  });

  it("renders an integer as a number, because JavaScript has one number type", () => {
    expect(renderType({ type: "integer" })).toBe("number");
  });

  it("parenthesises a union inside an array", () => {
    expect(renderType({ type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } }))
      .toBe("(string | null)[]");
  });

  it("renders a free-form object as a Record", () => {
    expect(renderType({ type: "object", additionalProperties: { type: "number" } })).toBe(
      "Record<string, number>",
    );
    expect(renderType({ type: "object" })).toBe("Record<string, unknown>");
  });

  it("renders a reference by name", () => {
    expect(renderType({ $ref: "#/components/schemas/Location" })).toBe("Location");
  });

  it("refuses a construct it does not handle rather than emitting a silent any", () => {
    // An `allOf` appearing in the document would mean the contract grew a shape this generator
    // does not understand. Failing loudly is the point: the alternative is a response typed
    // `unknown` that nobody notices until a screen reads a field that was never there.
    expect(() => renderType({ type: "geography" })).toThrow(/Unsupported schema type/);
    expect(() => renderType({ $ref: "https://example.com/Location" })).toThrow(
      /Only local schema references/,
    );
  });

  it("declares required and optional properties as the contract does", () => {
    const document: OpenApiDocument = {
      paths: {},
      components: {
        schemas: {
          Thing: {
            type: "object",
            description: "A thing.\n\nWith more detail below.",
            properties: {
              id: { type: "string", description: "Its identifier." },
              note: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["id"],
          },
        },
      },
    };

    const generated = generateApiTypes(document);

    expect(generated).toContain("export interface Thing {");
    expect(generated).toContain("/** A thing. */");
    expect(generated).toContain("/** Its identifier. */");
    expect(generated).toContain("readonly id: string;");
    expect(generated).toContain("readonly note?: string | null;");
  });

  it("records the status a success actually returns, including a bodiless 204", () => {
    const generated = readFileSync(GENERATED, "utf8");

    // Saving a location answers 201 with the record; removing one answers 204 with nothing. A
    // client that parsed the 204 as JSON would throw on an empty body and report a server fault.
    expect(generated).toContain('path: "/api/v1/me/locations",\n    requiresToken: true,\n    administrative: false,\n    request: "SavedLocationRequest",\n    successStatus: 201,\n    response: "SavedLocationRecord",');
    expect(generated).toContain('path: "/api/v1/me/locations/{saved_id}",\n    requiresToken: true,\n    administrative: false,\n    request: null,\n    successStatus: 204,\n    response: null,');
  });

  it("carries a union response as a union, so the caller must discriminate", () => {
    // `/locations/resolve` answers with a resolved location or a list of candidates, and
    // `specs/web-ui` requires the screen to present the candidates rather than pick one.
    expect(readFileSync(GENERATED, "utf8")).toContain(
      'response: "ResolvedResponse | AmbiguousResponse",',
    );
  });

  it("gives the two Attribution models names that say which is which", () => {
    const generated = readFileSync(GENERATED, "utf8");

    // FastAPI mangles a duplicated class name into its module path, which is neither a legal
    // TypeScript identifier nor a name anyone would want to read on a screen's props.
    expect(generated).toContain("export interface WeatherAttribution");
    expect(generated).toContain("export interface EvidenceAttribution");
    expect(generated).not.toContain("weathra__api__routers");
  });
});
