/**
 * Reading the readiness probe's inference line into something a person can use.
 *
 * `/ready` reports the configured inference dependency as one sentence — `"openrouter, model
 * nvidia/nemotron-3-super-120b-a12b:free."` — which is exactly right for a probe and wrong for a
 * settings page: it is a machine identifier printed where a product name belongs.
 *
 * **Everything below is derived from that string, never supplied beside it.** There is no table of
 * pretty names here, because a table is a second source of truth that goes stale the moment a
 * deployment changes its model — and a settings page confidently naming a model the backend is not
 * using is worse than one printing an identifier. So the label is the identifier's own tokens,
 * cased the way they are written elsewhere, and the identifier itself stays available verbatim.
 *
 * **An unrecognised shape keeps the sentence.** If the probe's wording changes, the raw detail is
 * shown rather than a half-parsed guess.
 */

export interface InferenceDescription {
  /** The gateway, as a product writes it: "OpenRouter". */
  readonly provider: string | null;
  /** The model, as a person reads it: "NVIDIA Nemotron 3 Super 120B". */
  readonly model: string | null;
  /** The identifier exactly as the backend reported it, for the technical disclosure. */
  readonly modelId: string | null;
  /** The probe's whole sentence, which is what to show when the shape is not recognised. */
  readonly detail: string | null;
}

/**
 * Gateways whose own capitalisation is not recoverable from a lowercase id.
 *
 * Two entries, and both are the company's own spelling of its own name. A gateway missing from here
 * is title-cased, which is the right guess for one word and never a claim about anything.
 */
const PROVIDERS: Readonly<Record<string, string>> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
};

/**
 * Vendors whose own spelling of their own name is not recoverable from a lowercase token.
 *
 * Orthography, not naming: every one of these words is already in the identifier, and the map only
 * says how its owner writes it. A vendor absent from here is title-cased, which is correct for most
 * and a claim about none. This is deliberately *not* a map of model names — that would be the
 * second source of truth this module exists without.
 */
const VENDORS: Readonly<Record<string, string>> = {
  nvidia: "NVIDIA",
  ibm: "IBM",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
};

/**
 * Tokens whose casing is a convention rather than a capitalised word.
 *
 * `9b` is nine billion parameters and is written `9B`; `v2` is a version and stays lowercase. These
 * are spelling rules for the identifier's own tokens, not names being supplied from outside.
 */
function caseToken(token: string): string {
  const vendor = VENDORS[token.toLowerCase()];
  if (vendor !== undefined) return vendor;
  if (/^\d+(\.\d+)?[bkmt]$/i.test(token)) return token.toUpperCase();
  if (/^a\d+b$/i.test(token)) return token.toUpperCase();
  if (/^v\d+(\.\d+)?$/i.test(token)) return token.toLowerCase();
  if (token.length <= 3 && /^[a-z]+$/i.test(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/** A model identifier as a title: `nvidia/nemotron-nano-9b-v2` → `NVIDIA Nemotron Nano 9B v2`. */
export function modelLabel(identifier: string): string {
  // The tier suffix — `:free`, `:nitro` — is a routing flag rather than part of the model's name.
  // It stays in the identifier, which is shown verbatim beside this.
  const withoutTier = identifier.split(":")[0] ?? identifier;
  return withoutTier
    .split("/")
    .flatMap((part) => part.split(/[-_]/))
    .filter((token) => token.length > 0)
    .map(caseToken)
    .join(" ");
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
