"use client";

/**
 * Settings — task 21.6.
 *
 * Everything a person owns and can change: their unit system, their default forecast horizon, their
 * default location, their conversations' memory, their sign-out, and the deletion of their Weathra
 * data. Six things, four protected endpoints, and no store of Weathra's own — preferences live in
 * `/api/v1/me/preferences`, conversations in `/api/v1/threads`, deletion in `/api/v1/me/data`, and
 * identity in Supabase Auth. Nothing here writes to `localStorage`: a preference kept in a browser
 * would not follow the person to another device, and `specs/memory` requires that it does.
 *
 * **A preference is applied by asking for it, not by relabelling.** Every screen that shows a figure
 * reads the same preferences under the same cache key, so saving imperial units invalidates that
 * read and the next screen *requests* imperial from the backend. The frontend converts nothing, and
 * there is no path by which a screen could show a Celsius figure with a Fahrenheit label.
 *
 * **The three destructive-sounding operations are three operations.** Signing out ends a session and
 * removes nothing. Deleting a conversation removes that conversation's short-term memory and
 * nothing durable. Deleting your Weathra data removes your records and does not delete your
 * sign-in. Each has its own control, its own wording, and its own confirmation.
 *
 * Built against `docs/design/screens/07-settings.png`. The artifact's tab row is reproduced with the
 * two sections that have something behind them; its time-format and primary-timezone controls, its
 * station vocabulary and its enterprise-licence footer are recorded in `docs/design/screens.md` §5
 * and §8.
 */

import { useState, type ReactNode } from "react";

import { ErrorState, LoadingState, TabPanel, Tabs } from "@/components/ui";
import { ViewStateSwitch } from "@/components/view-state";
import type { PreferenceView, SavedLocationsResponse } from "@/lib/api/schema";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY, SAVED_LOCATIONS_KEY } from "@/lib/query/keys";

import {
  AccountIdentity,
  ConversationMemory,
  DeleteAccountData,
  PreferenceForm,
} from "./sections";
import styles from "./settings.module.css";

import { FixtureSettings } from "./fixture-settings";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";

const TAB_PREFIX = "settings";

/**
 * The four sections `07-settings.png` draws, in its order.
 *
 * Two of them are drawn and disabled. `docs/design/screens.md` §8 records why neither is
 * implemented — model selection is not caller-selectable (`specs/model-policy`), and transparency
 * is the data-class labelling, attribution and evidence record on every screen rather than a page —
 * and that reasoning has not changed. What changed is the conclusion drawn from it: leaving them
 * out altered the artifact's tab row, and the section is part of the composition even when its
 * content is not this build's to write. Disabled, marked, and unreachable by keyboard, they
 * advertise nothing while keeping the row the artifact's shape.
 */
const TABS = [
  { id: "general", label: "General" },
  { id: "intelligence", label: "AI Intelligence", unavailable: "not in this release" },
  { id: "account", label: "Account" },
  { id: "transparency", label: "Transparency", unavailable: "not in this release" },
] as const;

export interface SettingsProps {
  /**
   * The existing sign-out control from task 20.9, rendered on the server and passed in.
   *
   * A prop rather than an import: `signOut` is a server action and this is a client component, and
   * the shell already establishes this pattern. There is one sign-out flow in Weathra and this is
   * it — Settings offers the same control, it does not implement another.
   */
  readonly signOutControl?: ReactNode;
}

/** The General tab, once the preferences it edits have resolved. */
function GeneralTab(): ReactNode {
  const preferences = useApiQuery<PreferenceView>({
    key: PREFERENCES_KEY,
    request: (client) => client.preferences(),
  });

  // The saved locations are the choices offered for the default. A failure here is not a reason to
  // withhold the whole form — the default-location control simply offers what it can.
  const saved = useApiQuery<SavedLocationsResponse>({
    key: SAVED_LOCATIONS_KEY,
    request: (client) => client.savedLocations(),
  });

  return (
    <ViewStateSwitch
      state={preferences.state}
      retry={preferences.retry}
      loading={() => <LoadingState label="Loading your preferences" lines={5} />}
      empty={() => <p className={styles.note}>Weathra could not read your preferences.</p>}
      error={(failure, again) => (
        <ErrorState failure={failure} title="Your preferences could not be loaded" onRetry={again} />
      )}
      ready={(view) => (
        <PreferenceForm view={view} saved={saved.state.kind === "ready" ? saved.state.data : null} />
      )}
    />
  );
}

export function Settings({ signOutControl }: SettingsProps): ReactNode {
  /*
   * Visual-fidelity review only.
   *
   * The flag's value is baked into the bundle at build time, so in a deployed build this comparison
   * is always false and nothing below it is reachable — but it is a *runtime* comparison against a
   * baked object rather than a folded constant, so the branch and the fixture screen do ship. See
   * `lib/fixtures/visily.ts` for what that does and does not guarantee. Nothing below changes. — the
   * production screen keeps every control it actually honours.
   */
  if (usingVisilyFixtures()) return <FixtureSettings />;
  const [tab, setTab] = useState<string>(TABS[0].id);

  return (
    <section className={styles.screen} aria-label="Settings">
      <header className={styles.heading}>
        <h1 className={styles.title}>Settings</h1>
        <p className={styles.subtitle}>
          Units, defaults, conversation memory and your Weathra data.
        </p>
      </header>

      <Tabs
        tabs={TABS}
        activeId={tab}
        onChange={setTab}
        label="Settings sections"
        idPrefix={TAB_PREFIX}
      />

      <TabPanel id="general" activeId={tab} idPrefix={TAB_PREFIX}>
        <GeneralTab />
      </TabPanel>

      <TabPanel id="account" activeId={tab} idPrefix={TAB_PREFIX}>
        <div className={styles.stack}>
          <AccountIdentity signOutControl={signOutControl} />
          <ConversationMemory />
          <DeleteAccountData signOutControl={signOutControl} />
        </div>
      </TabPanel>
    </section>
  );
}
