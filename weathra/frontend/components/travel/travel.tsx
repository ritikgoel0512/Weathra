"use client";

/**
 * Travel Intelligence — which days at a destination the weather favours, and why.
 *
 * Built against `docs/design/screens/15-travel-intelligence.png`: the trip header, the weather
 * window, the daily outlook, the derived guidance, the disclaimer.
 *
 * **The score is the backend's, not this screen's.** `POST /weather/comparison` already ranks the
 * days inside one place's window against a named criterion, and returns each day's score together
 * with the *contributions* that produced it. So the "travel viability index" the artifact draws is
 * replaced by a figure Weathra actually computes, with its components on screen — rather than by
 * arithmetic invented in a browser, which `specs/deterministic-analytics` puts in the backend for
 * exactly this reason.
 *
 * **It is weather, and says so.** The artifact carries flight stability, airline operations and
 * booking. Weathra knows none of those and offers none of them. What it can say is what the weather
 * is expected to do at a place over a window, which is what this screen says.
 */

import Link from "next/link";
import { useState, type ReactNode } from "react";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataClassBadge,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  LocationImage,
  Meter,
  Select,
} from "@/components/ui";
import type {
  ComparisonCandidate,
  ComparisonResult,
  Criterion,
  Location,
  PreferenceView,
} from "@/lib/api/schema";
import { briefingLocationFrom, formatReading, measureLabel } from "@/lib/dashboard/briefing";
import { friendlyName } from "@/lib/locations/place";
import { useApiMutation, useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY } from "@/lib/query/keys";

import styles from "./travel.module.css";

/** What "good weather to travel for" can mean, in the criteria the backend actually scores. */
const CRITERIA: readonly { value: Criterion; label: string }[] = [
  { value: "outdoor_suitability", label: "Good to be outside" },
  { value: "warmest", label: "Warmest" },
  { value: "coolest", label: "Coolest" },
  { value: "driest", label: "Driest" },
  { value: "least_windy", label: "Least windy" },
];

function DayRow({
  candidate,
  best,
}: {
  readonly candidate: ComparisonCandidate;
  readonly best: number;
}): ReactNode {
  return (
    <li className={styles.day}>
      <div className={styles.dayHead}>
        <span className={styles.dayRank}>{candidate.rank}</span>
        <span className={styles.dayLabel}>{candidate.label}</span>
        {candidate.rank === 1 ? <Badge tone="ok">Best in this window</Badge> : null}
        {candidate.tied ? <Badge tone="neutral">Tied</Badge> : null}
      </div>

      {/* The score relative to the best day in the window, so the bar means something without
          pretending the raw score is a percentage of anything. */}
      <Meter
        label={`Score for ${candidate.label}`}
        value={best === 0 ? null : Math.max(0, Math.min(1, candidate.score / best))}
      />

      {(candidate.supporting ?? []).length > 0 ? (
        <dl className={styles.supporting}>
          {candidate.supporting.map((statistic) => (
            <div key={`${statistic.measure}-${statistic.statistic}`}>
              <dt>{measureLabel(statistic.measure)}</dt>
              <dd>
                {statistic.value === null || statistic.value === undefined
                  ? "Not computable"
                  : formatReading({ value: statistic.value, unit: statistic.unit ?? null })}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {(candidate.contributions ?? []).length > 0 ? (
        <details className={styles.why}>
          <summary>What made this score</summary>
          <ul>
            {candidate.contributions!.map((contribution) => (
              <li key={contribution.measure}>
                {measureLabel(contribution.measure)}: {contribution.contribution}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function TravelFor({ location }: { readonly location: Location }): ReactNode {
  const [criterion, setCriterion] = useState<Criterion>("outdoor_suitability");
  const [days, setDays] = useState("7");

  const ranking = useApiMutation<void, ComparisonResult>({
    run: (client) =>
      client.compareLocations({
        criterion,
        location: friendlyName(location),
        days: Number(days),
      }),
  });

  const result = ranking.state.kind === "saved" ? ranking.state.data : null;
  const best = result?.candidates?.[0]?.score ?? 0;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div>
          <h1>Travel Intelligence</h1>
          <p className={styles.lede}>
            Which days at {friendlyName(location)} the weather favours, and what makes them score
            that way.
          </p>
        </div>
      </header>

      {/*
        The destination, photographed. `15-travel-intelligence.png` leads with imagery of the place
        and the production screen led with a read-only text field; the frame is the same whether a
        photograph is found or not, so nothing here can break or shift.
      */}
      <LocationImage
        displayName={friendlyName(location)}
        latitude={location.latitude}
        longitude={location.longitude}
        variant="hero"
        scrim="strong"
      >
        <span className={styles.heroPlace}>{friendlyName(location)}</span>
        <span className={styles.heroZone}>{location.timezone}</span>
      </LocationImage>

      <Card aria-labelledby="travel-controls">
        <CardHeader title="Your trip" titleId="travel-controls" />
        <CardBody>
          <div className={styles.controls}>
            <Input label="Destination" value={friendlyName(location)} readOnly />
            <Select
              label="What you want from the weather"
              value={criterion}
              onChange={(event) => setCriterion(event.target.value as Criterion)}
              options={CRITERIA.map((entry) => ({ value: entry.value, label: entry.label }))}
            />
            <Select
              label="Window"
              value={days}
              onChange={(event) => setDays(event.target.value)}
              options={[
                { value: "3", label: "Next 3 days" },
                { value: "7", label: "Next 7 days" },
                { value: "14", label: "Next 14 days" },
              ]}
            />
            <Button variant="primary" busy={ranking.busy} onClick={() => ranking.submit()}>
              Rank these days
            </Button>
          </div>
        </CardBody>
      </Card>

      {ranking.state.kind === "error" ? (
        <ErrorState failure={ranking.state.failure} title="Those days were not ranked" />
      ) : null}

      {result ? (
        <>
          <Card aria-labelledby="travel-window">
            <CardHeader
              title="Your weather window"
              titleId="travel-window"
              badge={<DataClassBadge dataClass="analytics" />}
              subtitle={`Ranked by ${result.criterion.replace(/_/g, " ")}, in ${location.timezone}, from ${result.provider}.`}
            />
            <CardBody>
              <ul className={styles.days}>
                {result.candidates.map((candidate) => (
                  <DayRow key={candidate.label} candidate={candidate} best={best} />
                ))}
              </ul>
              {(result.excluded?.length ?? 0) > 0 ? (
                <p className={styles.quiet}>
                  {result.excluded!.length} day
                  {result.excluded!.length === 1 ? " was" : "s were"} left out: the provider reported
                  too little to score them.
                </p>
              ) : null}
            </CardBody>
          </Card>

          <Card aria-labelledby="travel-caveat">
            <CardHeader title="What this is, and is not" titleId="travel-caveat" />
            <CardBody>
              <p className={styles.quiet}>
                This ranks days by the weather forecast for one place. It is not advice about
                flights, airlines, transport or bookings — Weathra has no information about any of
                them — and a forecast further out is less certain than one nearby.
              </p>
            </CardBody>
          </Card>
        </>
      ) : ranking.busy ? (
        <LoadingState label="Ranking the days in your window" lines={4} />
      ) : (
        <EmptyState title="Pick what you want from the weather">
          Weathra will rank each day in the window against it, and show what made each day score
          that way.
        </EmptyState>
      )}
    </div>
  );
}

export function TravelIntelligence(): ReactNode {
  const preferences = useApiQuery<PreferenceView>({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });

  if (preferences.state.kind === "loading") {
    return <LoadingState label="Reading your preferences" lines={4} />;
  }
  if (preferences.state.kind === "error") {
    return <ErrorState failure={preferences.state.failure} onRetry={preferences.retry} />;
  }
  if (preferences.state.kind !== "ready") return null;

  const location = briefingLocationFrom(preferences.state.data);
  if (location === null) {
    return (
      <EmptyState title="Choose a destination" action={<Link href="/settings">Open Settings</Link>}>
        Travel Intelligence ranks the days at your default location. Set one in Settings, or save a
        place first.
      </EmptyState>
    );
  }

  return <TravelFor location={location} />;
}
