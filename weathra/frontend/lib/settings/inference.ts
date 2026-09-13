/**
 * Reading the readiness probe's inference line into something a person can use.
 *
 * `/ready` reports the configured inference dependency as one sentence — a gateway, a comma, and
 * the word `model` followed by the gateway's own identifier for it — which is exactly right for a
 * probe and wrong for a settings page: it is a machine identifier printed where a product name
 * belongs.
 *
 * **Everything below is derived from that string, never supplied beside it.** There is no table of
 * model names here, and no vendor spelling either: a table is a second source of truth that goes
 * stale the moment a deployment changes its model, and naming a vendor in the frontend is the
 * coupling `specs/model-catalog` exists to prevent. So the label is the identifier's own tokens,
 * cased by convention, and the identifier itself stays available verbatim.
 *
 * **An unrecognised shape keeps the sentence.** If the probe's wording changes, the raw detail is
 * shown rather than a half-parsed guess — and a model nobody has seen yet still renders, because
 * nothing here recognises anything.
 */

export interface InferenceDescription {
  /** The gateway, as a product writes it: "OpenRouter". */
  readonly provider: string | null;
  /** The model, as a person reads it: `weather-reasoner-32b-v2` → "Weather Reasoner 32B v2". */
  readonly model: string | null;
  /** The identifier exactly as the backend reported it, for the technical disclosure. */
  readonly modelId: string | null;
  /** The probe's whole sentence, which is what to show when the shape is not recognised. */
  readonly detail: string | null;
}

/**
 * Gateways whose own capitalisation is not recoverable from a lowercase id.
 *
 * The *gateway* Weathra posts to, which is deployment configuration rather than a model: this is
 * the company's own spelling of its own name, and it decides nothing. A gateway missing from here
 * is title-cased, which is the right guess for one word and never a claim about anything.
 */
const PROVIDERS: Readonly<Record<string, string>> = {
  openrouter: "OpenRouter",
};

/**
 * Tokens whose casing is a convention rather than a capitalised word.
 *
 * `9b` is nine billion parameters and is written `9B`; `a12b` is the active count and follows it;
 * `v2` is a version and stays lowercase. These are spelling rules applied to whatever tokens the
 * identifier happens to contain — no token is recognised, looked up, or renamed.
 */
function caseToken(token: string): string {
  if (/^\d+(\.\d+)?[bkmt]$/i.test(token)) return token.toUpperCase();
  if (/^a\d+(\.\d+)?b$/i.test(token)) return token.toUpperCase();
  if (/^v\d+(\.\d+)?$/i.test(token)) return token.toLowerCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * A model identifier as a title: `weather-reasoner-32b-v2` → `Weather Reasoner 32B v2`.
 *
 * The namespace before the final `/` is the vendor's, and the routing tier after `:` — a `free` or
 * a `nitro` — is how the request is routed rather than what the model is called. Both stay in the
 * identifier, which is shown verbatim beside this label.
 */
export function modelLabel(identifier: string): string {
  const parts = identifier.split("/");
  const name = parts[parts.length - 1] ?? identifier;
  const withoutTier = name.split(":")[0] ?? name;
  const label = withoutTier
    .split(/[-_\s]+/)
    .filter((token) => token.length > 0)
    .map(caseToken)
    .join(" ");
  // An identifier made entirely of separators would leave nothing to show; the raw string is a
  // better answer than an empty field.
  return label.length > 0 ? label : identifier.trim();
}

/**
 * The probe's inference sentence, split into the fields a settings page shows.
 *
 * Matches `"<provider>, model <identifier>."` — the shape `api/routers/health.py` writes. Anything
 * else returns the sentence untouched under `detail`, with the parsed fields null.
 */
export function describeInference(detail: string | null | undefined): InferenceDescription {
  const empty: InferenceDescription = {
    provider: null,
    model: null,
    modelId: null,
    detail: detail ?? null,
  };
  if (!detail) return empty;

  const match = /^([A-Za-z0-9_.-]+),\s*model\s+([^\s.][^\s]*?)\.?$/.exec(detail.trim());
  if (match === null) return empty;

  const [, provider, identifier] = match as unknown as [string, string, string];
  return {
    provider: PROVIDERS[provider.toLowerCase()] ?? caseToken(provider),
    model: modelLabel(identifier),
    modelId: identifier,
    detail,
  };
}
