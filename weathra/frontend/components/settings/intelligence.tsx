"use client";

/**
 * Settings → AI Intelligence — `docs/design/screens/07-settings.png`.
 *
 * The tab was drawn and disabled, and the recorded reason was that Weathra has no model *selection*
 * to offer: `specs/model-policy` makes the model a backend decision, so a settings page of model
 * controls would be a page of controls that do nothing. That reasoning was right about controls and
 * wrong about the tab — what a person wants here is not to pick a model but to know **what the AI
 * is, what it is allowed to touch, and what it remembers**, and Weathra can answer all three
 * truthfully today.
 *
 * So this is read-first, and says so. Three rules hold.
 *
 * **No dead controls.** Nothing here is an editable preference unless the request path already
 * honours one. Response-length and emphasis toggles would be stored and ignored, which is worse
 * than not offering them: a person would change their answers' shape in their head and not on the
 * screen. The one genuinely editable thing on this tab is conversation memory, which is a deletion
 * and already works.
 *
 * **The provider and model come from `/ready`, never from a constant here.** That probe reports what
 * the deployment is actually configured with, so this page cannot claim a model the backend is not
 * using. It carries no credential — `_inference` in `api/routers/health.py` reports the provider id
 * and model id and deliberately never whether *this* key is valid.
 *
 * **Unconfigured is a state, not an error.** `specs/agent-orchestration` requires every non-agent
 * capability to work without an inference credential, so a deployment without one is a deployment
 * where this page says the analyst is unavailable and every other screen carries on.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { Badge, Card, CardBody, CardHeader, DataClassBadge, Skeleton } from "@/components/ui";
import type { ReadinessResponse, UsageResponse } from "@/lib/api/schema";
import { useApiQuery } from "@/lib/query/hooks";

import { describeInference } from "@/lib/settings/inference";

import { ConversationMemory } from "./sections";
import styles from "./settings.module.css";

/** One dependency out of the readiness probe, by the name the backend gives it. */
function dependency(
  readiness: ReadinessResponse | null,
  name: string,
): ReadinessResponse["dependencies"][number] | null {
  return (readiness?.dependencies ?? []).find((entry) => entry.name === name) ?? null;
}

/**
 * The analyst's own state: whether it is available, and what is behind it.
 *
 * The detail string is the backend's. Rendering it rather than reassembling a sentence from its
 * parts is what stops this page and the probe disagreeing about which model is configured.
 */
function Analyst({
  readiness,
  pending,
}: {
  readonly readiness: ReadinessResponse | null;
  /** Whether the probe is still in flight. Distinct from having answered with nothing. */
  readonly pending: boolean;
}): ReactNode {
  const inference = dependency(readiness, "inference_provider");
  const configured = inference?.configured ?? false;
  const described = describeInference(inference?.detail);

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="AI Weather Analyst"
        subtitle="Weathra can use a language model to explain retrieved and computed weather evidence."
      />
      <CardBody>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Status</dt>
            <dd>
              {pending ? (
                <Skeleton height="var(--space-4)" />
              ) : inference === null ? (
                <span className={styles.factDetail}>Weathra could not read this just now.</span>
              ) : (
                <Badge tone={configured ? "ok" : "neutral"}>
                  {configured ? "Available" : "Unavailable"}
                </Badge>
              )}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Provider</dt>
            <dd>
              {pending ? <Skeleton height="var(--space-4)" /> : (described.provider ?? "—")}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Model</dt>
            {/*
              Read out of the identifier the probe reported, never out of a table beside it: a
              lookup of pretty model names goes stale the moment a deployment changes its model, and
              a settings page confidently naming a model the backend is not using is worse than one
              printing an identifier. The identifier itself is a press away, verbatim.
            */}
            <dd>
              {pending ? (
                <Skeleton height="var(--space-4)" />
              ) : described.model !== null ? (
                <>
                  {described.model}
                  {described.modelId ? (
                    <details className={styles.technical}>
                      <summary>Technical details</summary>
                      <p className={styles.factDetail}>{described.detail}</p>
                    </details>
                  ) : null}
                </>
              ) : (
                <span className={styles.factDetail}>
                  {described.detail ?? "Not reported by this deployment."}
                </span>
              )}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Choosing a model</dt>
            <dd className={styles.factDetail}>
              Weathra selects the model for each task under its own model policy. It is not a
              per-account setting, so there is nothing to change here.
            </dd>
          </div>
        </dl>
        {configured ? null : (
          <p className={styles.note}>
            Every other capability works without it — forecasts, history, analytics, comparison,
            saved locations, watches and preferences are all unaffected.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/** What the model is allowed to touch, stated as the boundary it actually is. */
function Grounding(): ReactNode {
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Grounded analysis"
        subtitle="What the language model does, and what it does not."
      />
      <CardBody>
        <p className={styles.paragraph}>
          Forecast and observed values are retrieved from weather providers. Historical comparisons
          and the statistics on the analysis screens are computed by Weathra. A language model may
          explain those figures — it does not produce the observations, and it does not produce the
          deterministic statistics.
        </p>
        <ul className={styles.classList}>
          <li>
            <DataClassBadge dataClass="observed" />
            <DataClassBadge dataClass="forecast" />
            <DataClassBadge dataClass="historical" />
            <span>Retrieved from a provider.</span>
          </li>
          <li>
            <DataClassBadge dataClass="analytics" />
            <span>Computed by Weathra, deterministically.</span>
          </li>
          <li>
            <DataClassBadge dataClass="interpretation" />
            <span>Written by a model about the figures above, which it did not produce.</span>
          </li>
        </ul>
        <p className={styles.note}>
          Every figure on every screen carries one of these labels, so which of the three produced a
          number is never something you have to infer.
        </p>
        <Link className={styles.link} href="/evidence">
          Open Agent Evidence
        </Link>
      </CardBody>
    </Card>
  );
}

/**
 * What Weathra remembers, in the two senses it means it.
 *
 * Read-only on the preference half and a real deletion on the conversation half, because that is
 * what exists: preferences are the long-term memory and they are edited on the General tab rather
 * than switched off here, and a thread is the short-term memory and deleting it is the control.
 */
function Memory(): ReactNode {
  return (
    <>
      <Card>
        <CardHeader
        headingLevel={2}
          title="Memory"
          subtitle="What Weathra carries between questions, and what it keeps for next time."
        />
        <CardBody>
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt>Conversation context</dt>
              <dd className={styles.factDetail}>
                Used for follow-up questions inside the same conversation — the place, the window,
                the units. Deleting a conversation removes it.
              </dd>
            </div>
            <div className={styles.fact}>
              <dt>Preference memory</dt>
              <dd className={styles.factDetail}>
                Reuses your units, default forecast horizon and default location. Change or reset
                them on the General tab.
              </dd>
            </div>
          </dl>
          <p className={styles.note}>
            Weathra keeps no other memory of your questions. There is nothing hidden behind these two
            to inspect or switch off.
          </p>
        </CardBody>
      </Card>
      <ConversationMemory />
    </>
  );
}

/** The person's own recent model usage. Their own, from their own token's subject. */
function RecentUse(): ReactNode {
  const usage = useApiQuery<UsageResponse>({
    key: ["me", "usage"],
    request: (client) => client.usage(),
  });
  if (usage.state.kind !== "ready") return null;

  const recent = usage.state.data.recent;
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Your recent AI use"
        subtitle={`Language model calls made for you over the last ${recent.days} days.`}
      />
      <CardBody>
        <dl className={styles.counters}>
          <div className={styles.counter}>
            <dt>Calls</dt>
            <dd>{recent.calls}</dd>
          </div>
          <div className={styles.counter}>
            <dt>Failed</dt>
            <dd>{recent.failures}</dd>
          </div>
          <div className={styles.counter}>
            <dt>Plan</dt>
            <dd>{usage.state.data.plan_name}</dd>
          </div>
        </dl>
        <Link className={styles.link} href="/plan">
          Open Plan &amp; Usage
        </Link>
      </CardBody>
    </Card>
  );
}

export function IntelligenceTab(): ReactNode {
  const readiness = useApiQuery<ReadinessResponse>({
    key: ["ready"],
    request: (client) => client.readiness(),
  });

  return (
    <div className={styles.stack}>
      {/*
        Recent use sits directly under the analyst it is about. It was last on the tab, which put it
        beneath the whole conversation list — three counted figures reachable only by scrolling
        through somebody's history.
      */}
      <Analyst
        readiness={readiness.state.kind === "ready" ? readiness.state.data : null}
        pending={readiness.state.kind === "loading"}
      />
      <RecentUse />
      <Grounding />
      <Memory />
    </div>
  );
}
