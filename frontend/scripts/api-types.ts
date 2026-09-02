/**
 * Generate `lib/api/schema.ts` from the backend's committed OpenAPI document.
 *
 * **Why generated rather than hand-written.** The response models are the backend's, and there are
 * seventy-two of them. Transcribing them by hand would produce a second, subtly different
 * description of the same contract, and the day they diverged nothing would say so — a screen would
 * read a field the API had renamed and render `undefined`. Generating them means the frontend's
 * types cannot describe an API the backend does not serve: `api-types.test.ts` regenerates and
 * compares, so a changed contract fails the frontend's test run until the types are regenerated
 * with `npm run api:types`.
 *
 * **Why the operations table is generated too.** `security` on an operation is how the backend says
 * a call needs a bearer token, and `parameters` is how it declares what a call may send. Emitting
 * both lets the client's tests assert the two properties task 20.11 asks for — the header is
 * attached to every protected call, and no call invents a parameter — against the contract itself
 * rather than against a list somebody remembered to update.
 *
 * This module is deliberately narrow. It handles the constructs FastAPI actually emits for this
 * application — `$ref`, `anyOf`, `enum`, `const`, `additionalProperties`, arrays, and the scalar
 * types — and throws on anything else rather than emitting a silent `unknown`. A generator that
 * degrades quietly is a generator that types a whole response as `any` the first time someone adds
 * an `allOf`.
 */

/** The subset of JSON Schema the backend's document uses. */
export interface JsonSchema {
  readonly $ref?: string;
  readonly type?: string;
  readonly anyOf?: readonly JsonSchema[];
  readonly enum?: readonly (string | number)[];
  readonly const?: string | number | boolean;
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: JsonSchema | boolean;
  readonly description?: string;
  readonly title?: string;
  readonly format?: string;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly schema?: JsonSchema;
}

export interface OpenApiOperation {
  readonly operationId?: string;
  readonly summary?: string;
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly content?: Readonly<Record<string, { readonly schema?: JsonSchema }>>;
  };
  readonly responses?: Readonly<
    Record<
      string,
      { readonly content?: Readonly<Record<string, { readonly schema?: JsonSchema }>> }
    >
  >;
}

export interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components: { readonly schemas: Readonly<Record<string, JsonSchema>> };
}

/**
 * Schema names that need renaming.
 *
 * FastAPI mangles a duplicated class name into its full module path, which is a Python detail and
 * not a legal TypeScript identifier anyone would want to read. Both of these are genuinely
 * different models — the weather routers' attribution block carries the provider and retrieval
 * time for a screen; the evidence record's carries the fuller provenance — so they get names that
 * say which is which rather than one being folded into the other.
 */
const RENAMED: Readonly<Record<string, string>> = {
  weathra__api__routers__weather__Attribution: "WeatherAttribution",
  weathra__domain__evidence__Attribution: "EvidenceAttribution",
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function typeName(schemaName: string): string {
  const renamed = RENAMED[schemaName];
  if (renamed !== undefined) return renamed;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Schema name is not a usable TypeScript identifier: ${schemaName}`);
  }
  return schemaName;
}

function referencedName(reference: string): string {
  const prefix = "#/components/schemas/";
  if (!reference.startsWith(prefix)) {
    throw new Error(`Only local schema references are supported, got: ${reference}`);
  }
  return typeName(reference.slice(prefix.length));
}

function literal(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** One schema as a TypeScript type expression. */
export function renderType(schema: JsonSchema, indent = ""): string {
  if (schema.$ref !== undefined) return referencedName(schema.$ref);
  if (schema.const !== undefined) return literal(schema.const);

  if (schema.anyOf !== undefined) {
    const members = schema.anyOf.map((member) => renderType(member, indent));
    return [...new Set(members)].join(" | ");
  }

  if (schema.enum !== undefined) {
    return schema.enum.map(literal).join(" | ");
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      if (schema.items === undefined) return "unknown[]";
      return `${wrapUnion(renderType(schema.items, indent))}[]`;
    case "object":
      return renderObject(schema, indent);
    case undefined:
      // An empty schema: the stream endpoint, whose body is an SSE stream rather than JSON.
      return "unknown";
    default:
      throw new Error(`Unsupported schema type: ${schema.type}`);
  }
}

function wrapUnion(rendered: string): string {
  return rendered.includes(" | ") ? `(${rendered})` : rendered;
}

function renderObject(schema: JsonSchema, indent: string): string {
  if (schema.properties !== undefined) {
    return renderProperties(schema, indent);
  }
  const additional = schema.additionalProperties;
  if (additional === undefined || additional === true) return "Record<string, unknown>";
  if (additional === false) return "Record<string, never>";
  return `Record<string, ${renderType(additional, indent)}>`;
}

/** The first line of a description, as a doc comment. */
function documentation(schema: JsonSchema, indent: string): string {
  const description = schema.description?.trim();
  if (!description) return "";
  const first = description.split("\n")[0]?.trim() ?? "";
  if (first === "") return "";
  return `${indent}/** ${first.replace(/\*\//g, "*\\/")} */\n`;
}

function renderProperties(schema: JsonSchema, indent: string): string {
  const inner = `${indent}  `;
  const required = new Set(schema.required ?? []);
  const lines: string[] = ["{"];

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    lines.push(documentation(property, inner).trimEnd());
    // Optional in TypeScript exactly when the contract says a payload may omit it. Faithful
    // rather than convenient: a field with a default is one the backend may add, remove, or start
    // sending, and pretending otherwise moves the surprise to runtime.
    const marker = required.has(name) ? "" : "?";
    lines.push(`${inner}readonly ${propertyKey(name)}${marker}: ${renderType(property, inner)};`);
  }

  lines.push(`${indent}}`);
  return lines.filter((line) => line !== "").join("\n");
}

function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function renderSchema(name: string, schema: JsonSchema): string {
  const declared = typeName(name);
  const header = documentation(schema, "");

  if (schema.enum !== undefined || schema.const !== undefined) {
    return `${header}export type ${declared} = ${renderType(schema)};\n`;
  }
  if (schema.type === "object" || schema.properties !== undefined) {
    const body = renderType(schema);
    if (body.startsWith("{")) {
      return `${header}export interface ${declared} ${body}\n`;
    }
    return `${header}export type ${declared} = ${body};\n`;
  }
  return `${header}export type ${declared} = ${renderType(schema)};\n`;
}

function schemaReference(
  content: Readonly<Record<string, { readonly schema?: JsonSchema }>> | undefined,
): string | null {
  const json = content?.["application/json"]?.schema;
  if (json === undefined) return null;
  if (json.$ref !== undefined) return referencedName(json.$ref);

  // `/locations/resolve` answers with either a resolved location or a list of candidates, which
  // FastAPI documents as an `anyOf` of two models rather than one wrapper. The client's caller has
  // to discriminate, so the union is what it must be given.
  if (json.anyOf !== undefined) {
    const members = json.anyOf
      .filter((member) => member.$ref !== undefined)
      .map((member) => referencedName(member.$ref as string));
    return members.length === 0 ? null : members.join(" | ");
  }
  return null;
}

/**
 * The successful response an operation declares, and its status.
 *
 * Not every success is a 200: saving a location answers 201, and the deletions that remove
 * something answer 204 with no body at all. The client needs to know which, because parsing a
 * 204 as JSON throws on an empty body — a bug that looks like a server fault and is not one.
 */
function successResponse(operation: OpenApiOperation): { status: number; schema: string | null } {
  const responses = operation.responses ?? {};
  const status = Object.keys(responses)
    .filter((code) => code.startsWith("2"))
    .sort()[0];

  if (status === undefined) return { status: 200, schema: null };
  return { status: Number(status), schema: schemaReference(responses[status]?.content) };
}

function renderOperations(document: OpenApiDocument): string {
  const rows: string[] = [];

  for (const [path, operations] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = operations[method];
      if (operation === undefined) continue;

      const success = successResponse(operation);
      const parameters = (operation.parameters ?? []).map(
        (parameter) =>
          `      { name: ${JSON.stringify(parameter.name)}, in: ${JSON.stringify(parameter.in)}, ` +
          `required: ${parameter.required === true} },`,
      );

      rows.push(
        [
          "  {",
          `    operationId: ${JSON.stringify(operation.operationId ?? "")},`,
          `    method: ${JSON.stringify(method.toUpperCase())},`,
          `    path: ${JSON.stringify(path)},`,
          `    requiresToken: ${(operation.security ?? []).length > 0},`,
          `    request: ${JSON.stringify(schemaReference(operation.requestBody?.content))},`,
          `    successStatus: ${success.status},`,
          `    response: ${JSON.stringify(success.schema)},`,
          parameters.length === 0
            ? "    parameters: [],"
            : ["    parameters: [", ...parameters, "    ],"].join("\n"),
          "  },",
        ].join("\n"),
      );
    }
  }

  return [
    "/** A parameter an operation accepts, as the contract declares it. */",
    "export interface ApiParameter {",
    "  readonly name: string;",
    '  readonly in: "query" | "path" | "header";',
    "  readonly required: boolean;",
    "}",
    "",
    "/** One operation the backend serves. */",
    "export interface ApiOperation {",
    "  readonly operationId: string;",
    '  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";',
    "  readonly path: string;",
    "  /** Whether the call carries the access token as a bearer header. */",
    "  readonly requiresToken: boolean;",
    "  /** The request body's schema, or null when the operation takes no body. */",
    "  readonly request: string | null;",
    "  /** The status a successful call returns: 200, 201, or 204 for no content. */",
    "  readonly successStatus: number;",
    "  /** The success response's schema, or null when the call returns no JSON body. */",
    "  readonly response: string | null;",
    "  readonly parameters: readonly ApiParameter[];",
    "}",
    "",
    "/**",
    " * Every operation the backend serves, read off its OpenAPI document.",
    " *",
    " * The client's tests iterate this, so a protected operation added to the backend is one the",
    " * frontend's tests immediately have an opinion about.",
    " */",
    "export const API_OPERATIONS: readonly ApiOperation[] = [",
    ...rows,
    "];",
    "",
  ].join("\n");
}

const HEADER = `/**
 * The backend's API contract, in TypeScript.
 *
 * GENERATED FILE — do not edit. Regenerate with \`npm run api:types\` after the backend's
 * \`openapi.json\` changes (which \`python scripts/dump_openapi.py\` in backend/ produces).
 *
 * Property names are the wire format's, so they stay snake_case: this describes what the API
 * sends, not how the frontend would have named it. A property is optional here exactly when the
 * contract permits the payload to omit it.
 */
`;

/** The whole of `lib/api/schema.ts`. */
export function generateApiTypes(document: OpenApiDocument): string {
  const schemas = Object.entries(document.components.schemas).sort(([left], [right]) =>
    typeName(left).localeCompare(typeName(right)),
  );

  const rendered = schemas.map(([name, schema]) => renderSchema(name, schema));

  return [HEADER, ...rendered.map((block) => `\n${block}`), "\n", renderOperations(document)].join(
    "",
  );
}
