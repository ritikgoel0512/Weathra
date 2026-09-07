"use client";

/**
 * The SAVED LOCATIONS section of the navigation rail.
 *
 * Every product artifact carries it under the primary navigation: a small uppercase heading, an add
 * control beside it, and the person's places listed beneath with the current one marked. It was the
 * one part of the rail with no implementation, because the shell had no way to ask the backend for
 * anything; `components/shell/protected-frame.tsx` is what changed that.
 *
 * **The entries are the person's own saved locations and nothing else.** The artifacts list Berlin,
 * Tokyo, New York and London with a temperature beside each; those are mockup content, and the
 * temperatures would each be a separate weather request per place on every screen. What is listed
 * here is what `GET /api/v1/me/locations` returns — the label they chose or the canonical name the
 * backend resolved — and nothing is listed when they have saved nothing.
 *
 * **The section keeps its geometry in every state.** Loading says so, an empty list says so and
 * points at the screen that fills it, and a failure says the list could not be loaded rather than
 * quietly rendering as though the person had saved nothing. An absent section would be a different
 * shape of rail on the most common state of a new account.
 *
 * **"Active" here means the Dashboard is briefing on that place**, which is a real thing a person
 * can act on: following an entry sets `?place=`, the same parameter the header search uses, and the
 * Dashboard resolves it through the backend. It is marked with `aria-current="true"` rather than
 * `"page"` — the destination is one page for all of them, and the distinction is which place that
 * page is about.
 */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { SHELL_FIXTURE, usingVisilyFixtures } from "@/lib/fixtures/visily";
import { useApiQuery } from "@/lib/query/hooks";
import { SAVED_LOCATIONS_KEY } from "@/lib/query/keys";
import { DEFAULT_PROTECTED_PATH } from "@/lib/routes";
import type { SavedLocationsResponse } from "@/lib/api/schema";

import { Icon } from "./icons";
import styles from "./shell.module.css";

/** The screen that owns saving and removing. Its path is the navigation record's. */
const SAVED_LOCATIONS_PATH = "/locations";

/** The name to show for one saved place: what they called it, else what the backend resolved. */
function labelFor(record: {
  readonly label?: string | null;
  readonly location: { readonly display_name: string };
}): string {
  const chosen = record.label?.trim();
  return chosen && chosen.length > 0 ? chosen : record.location.display_name;
}

export interface SavedRailProps {
  /** Closes the drawer when an entry is followed, as the primary navigation does. */
  readonly onNavigate?: () => void;
}

export function SavedRail({ onNavigate }: SavedRailProps): ReactNode {
  const pathname = usePathname();
  const asked = useSearchParams().get("place")?.trim() ?? "";

  const { state } = useApiQuery<SavedLocationsResponse>({
    key: SAVED_LOCATIONS_KEY,
    request: (client) => client.savedLocations(),
    isEmpty: (data) => data.locations.length === 0,
  });

  const onDashboard = pathname === DEFAULT_PROTECTED_PATH;
  /*
   * `01-dashboard.png` lists four saved places. In fidelity mode the rail shows the artifact's list
   * so the screenshots line up; in production it is whatever the person actually saved.
   */
  const fidelity = usingVisilyFixtures();
  const records = fidelity
    ? SHELL_FIXTURE.savedLocations.map((name) => ({
        id: name,
        label: name,
        location: { display_name: name },
      }))
    : state.kind === "ready"
      ? state.data.locations
      : [];

  return (
    <section className={styles.saved} aria-labelledby="weathra-saved-heading">
      <div className={styles.savedHeader}>
        <h2 className={styles.savedHeading} id="weathra-saved-heading">
          Saved locations
        </h2>
        <Link
          className={styles.savedAdd}
          href={SAVED_LOCATIONS_PATH}
          aria-label="Add a saved location"
          onClick={onNavigate}
        >
          <Icon name="locations" size={16} />
        </Link>
      </div>

      {!fidelity && state.kind === "loading" ? (
        <p className={styles.savedNote}>Loading your places…</p>
      ) : !fidelity && state.kind === "error" ? (
        <p className={styles.savedNote}>Your saved places could not be loaded.</p>
      ) : records.length === 0 ? (
        <p className={styles.savedNote}>
          Nothing saved yet. <Link href={SAVED_LOCATIONS_PATH}>Add a place</Link>.
        </p>
      ) : (
        <ul className={styles.savedList}>
          {records.map((record) => {
            const name = labelFor(record);
            const briefing = onDashboard && asked !== "" && asked === name;
            return (
              <li key={record.id}>
                <Link
                  className={styles.savedEntry}
                  href={`${DEFAULT_PROTECTED_PATH}?place=${encodeURIComponent(name)}`}
                  data-active={briefing ? "true" : undefined}
                  aria-current={briefing ? "true" : undefined}
                  onClick={onNavigate}
                >
                  <span className={styles.savedPin} aria-hidden="true">
                    <Icon name="locations" size={16} />
                  </span>
                  <span className={styles.savedName}>{name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
