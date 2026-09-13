"use client";

/**
 * Settings → Transparency — `docs/design/screens/07-settings.png`.
 *
 * The tab was drawn and disabled, and the recorded reason was that transparency *is* the data-class
 * badge, the attribution line and the evidence record on every screen, rather than a page about
 * them. That is still true and it is not an argument against this page: those labels only work if a
 * person knows what the five of them mean, and nowhere in the product said so. This is where they
 * are defined.
 *
 * Read-only throughout — there is nothing here to configure — so the tab carries no save bar.
 *
 * **Everything on this page is either a definition or a fact from the backend.** The classes come
 * from `components/ui/badge.tsx`, which is the same table every badge in the product renders from,
 * so a class renamed there is renamed here. The sources come from `/ready`, which reports what the
 * deployment is actually configured with — a hardcoded list would go on claiming a provider after
 * somebody changed it.
 *
 * **No retention periods are stated.** Weathra does expire some records, but nothing exposes those
 * windows to a person, and a number typed here would be a promise this page cannot keep.
 *
 * **And none of the artifact's governance apparatus.** No certification, no compliance lock, no
 * model audit, no regulatory status, no enterprise licence. Weathra has none of them, and a
 * transparency page is the single worst place to imply otherwise.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  DATA_CLASS_DESCRIPTIONS,
  DataClassBadge,
  Skeleton,
} from "@/components/ui";
import type { DependencyStatus, ReadinessResponse } from "@/lib/api/schema";
import type { DataClassName } from "@/lib/design/tokens";
import { useApiQuery } from "@/lib/query/hooks";

import styles from "./settings.module.css";

/** The five classes every figure in Weathra carries, in the order the design system lists them. */
const CLASSES: readonly DataClassName[] = [
  "observed",
  "forecast",
  "historical",
  "analytics",
  "interpretation",
];

/** What each dependency the probe names is, in words a person reads. */
const SOURCE_NAMES: Readonly<Record<string, { label: string; blurb: string }>> = {
  weather_provider: {
    label: "Weather provider",
    blurb:
      "Observed conditions, forecasts and archived observations are retrieved from it. Answering a question about a place sends that place to it.",
  },
  inference_provider: {
    label: "Language model provider",
    blurb:
      "Used only to write explanations of figures Weathra already retrieved or computed. Unavailable deployments keep every other capability.",
  },
  vector_store: {
    label: "Knowledge corpus",
    blurb:
      "Weathra's own explanatory reference material, searched to support an answer rather than to produce a weather value.",
  },
  authentication_provider: {
    label: "Sign-in provider",
    blurb: "Holds your credentials and your email address. Weathra stores neither.",
  },
  database: {
    label: "Weathra's own store",
    blurb:
      "Your saved locations, watches, preferences and conversations. Scoped to your account by the database itself.",
  },
};

/** The dependencies worth showing a person. A probe reports more than a settings page should. */
const SHOWN = Object.keys(SOURCE_NAMES);

function Sources({
  readiness,
  pending,
}: {
  readonly readiness: ReadinessResponse | null;
  readonly pending: boolean;
}): ReactNode {
  const dependencies: readonly DependencyStatus[] = readiness?.dependencies ?? [];
  const shown = dependencies.filter((entry) => SHOWN.includes(entry.name));

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Where Weathra's answers come from"
        subtitle="What this deployment is configured with, reported by the service itself."
      />
      <CardBody>
        {pending ? (
          <Skeleton height="var(--space-6)" />
        ) : readiness === null ? (
          <p className={styles.note}>
            Weathra could not read what this deployment is configured with just now.
          </p>
        ) : (
          <ul className={styles.sourceList}>
            {shown.map((entry) => {
              const named = SOURCE_NAMES[entry.name]!;
              return (
                <li className={styles.source} key={entry.name}>
                  <span className={styles.sourceHead}>
                    <span className={styles.sourceName}>{named.label}</span>
                    <Badge tone={entry.configured ? "ok" : "neutral"}>
                      {entry.configured ? "Configured" : "Not configured"}
                    </Badge>
                  </span>
                  <span className={styles.sourceBlurb}>{named.blurb}</span>
                  {/*
                    The probe's own sentence, which names the provider and — for the model — which
                    model. It never carries a credential.
                  */}
                  {entry.detail ? (
                    <span className={styles.sourceDetail}>{entry.detail}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <p className={styles.note}>
          Which sources a particular answer used is recorded per run, and readable in Agent Evidence.
        </p>
      </CardBody>
    </Card>
  );
}

export function TransparencyTab(): ReactNode {
  const readiness = useApiQuery<ReadinessResponse>({
    key: ["ready"],
    request: (client) => client.readiness(),
  });

  return (
    <div className={styles.stack}>
      <Card>
        <CardHeader
        headingLevel={2}
          title="How Weathra labels data"
          subtitle="Every figure on every screen carries exactly one of these five."
        />
        <CardBody>
          <dl className={styles.classes}>
            {CLASSES.map((name) => (
              <div className={styles.class} key={name}>
                <dt>
                  <DataClassBadge dataClass={name} />
                </dt>
                <dd>{DATA_CLASS_DESCRIPTIONS[name]}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.note}>
            The label is part of the figure rather than something a screen writes beside it, so the
            same content always announces itself the same way.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
        headingLevel={2}
          title="What AI does — and does not do"
          subtitle="The boundary the labels above exist to hold."
        />
        <CardBody>
          <p className={styles.paragraph}>
            Forecast and observed values are retrieved from a weather provider. Historical
            comparisons and the statistics on the analysis screens are computed by Weathra, the same
            way every time. A language model may explain those figures, but it does not create the
            underlying observations and it does not create the deterministic statistics.
          </p>
          <p className={styles.note}>
            Weathra does not present a model&rsquo;s prose as a measurement, and it does not present
            a measurement as an interpretation.
          </p>
        </CardBody>
      </Card>

      <Sources
        readiness={readiness.state.kind === "ready" ? readiness.state.data : null}
        pending={readiness.state.kind === "loading"}
      />

      <Card>
        <CardHeader
        headingLevel={2}
          title="Agent Evidence"
          subtitle="The record behind an AI-assisted answer."
        />
        <CardBody>
          <p className={styles.paragraph}>
            Agent Evidence records the stages a run went through, the sources it retrieved, the
            figures it computed, the context it used, and the answer it produced from them. It is
            how an answer is checked rather than trusted.
          </p>
          <Link className={styles.link} href="/evidence">
            Open Agent Evidence
          </Link>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
        headingLevel={2}
          title="What Weathra stores about you"
          subtitle="Kept under your account, and reachable only by it."
        />
        <CardBody>
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt>Saved locations</dt>
              <dd className={styles.factDetail}>
                The places you saved, as the canonical location the resolver returned.
              </dd>
            </div>
            <div className={styles.fact}>
              <dt>Weather watches</dt>
              <dd className={styles.factDetail}>
                The conditions you asked Weathra to check, and what each scheduled check found, so
                the history is there to read back.
              </dd>
            </div>
            <div className={styles.fact}>
              <dt>Conversations</dt>
              <dd className={styles.factDetail}>
                Your questions and their answers, so a follow-up can use the context of the one
                before it. Deleting a conversation removes it.
              </dd>
            </div>
            <div className={styles.fact}>
              <dt>Preferences</dt>
              <dd className={styles.factDetail}>
                Units, default forecast horizon and default location. Nothing is inferred from what
                you look at.
              </dd>
            </div>
          </dl>
          <p className={styles.note}>
            Your email address and password stay with your sign-in provider; Weathra stores neither.
            Everything above is removable from the Account tab.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
