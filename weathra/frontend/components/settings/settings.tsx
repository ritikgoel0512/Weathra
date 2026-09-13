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
 * Built against `docs/design/screens/07-settings.png`, and all four of its tabs now open.
 *
 * **Two of them used to be drawn and disabled**, on the reasoning that Weathra has no model
 * *selection* to offer and that transparency is the badge on every figure rather than a page. Both
 * halves were right about controls and wrong about the tabs: what a person wants under AI
 * Intelligence is to know what the model is, what it may touch and what is remembered, and what
 * they want under Transparency is the meaning of the five labels every screen already shows them.
 * Weathra can answer all of that truthfully and now does, without one dead control on either.
 *
 * **The tab is in the URL.** `?tab=` survives a reload and can be linked to, which is what makes
 * "the Transparency tab says so" a thing anybody can send somebody else.
 *
 * Its time-format and primary-timezone controls remain absent, and `docs/design/screens.md` §5
 * records why: Weathra shows each place in its own local time by design, and a per-account display
 * timezone would contradict that; time formatting is not centralised, so a 12/24-hour preference
 * could be stored and then honoured in some places and not others. Its station vocabulary and
 * enterprise-licence footer stay out for the reasons §8 gives.
 */

import { useCallback, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ErrorState, LoadingState, TabPanel, Tabs } from "@/components/ui";
import { ViewStateSwitch } from "@/components/view-state";
import type { PreferenceView, SavedLocationsResponse } from "@/lib/api/schema";
import { useApiQuery } from "@/lib/query/hooks";
import { PREFERENCES_KEY, SAVED_LOCATIONS_KEY } from "@/lib/query/keys";

import {
  AccountIdentity,
  DeleteAccountData,
  PreferenceForm,
} from "./sections";
import { IntelligenceTab } from "./intelligence";
import { TransparencyTab } from "./transparency";
import styles from "./settings.module.css";

import { FixtureSettings } from "./fixture-settings";
import { usingVisilyFixtures } from "@/lib/fixtures/visily";

const TAB_PREFIX = "settings";

/** The four sections `07-settings.png` draws, in its order. Every one of them opens. */
const TABS = [
  { id: "general", label: "General", icon: "general" },
  { id: "intelligence", label: "AI Intelligence", icon: "intelligence" },
  { id: "account", label: "Account", icon: "account" },
  { id: "transparency", label: "Transparency", icon: "transparency" },
] as const;

const TAB_IDS = TABS.map((tab) => tab.id) as readonly string[];

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
  return <SettingsScreen signOutControl={signOutControl} />;
}

function SettingsScreen({ signOutControl }: SettingsProps): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  /*
   * The URL seeds the tab; state renders it; the URL is kept in step.
   *
   * `?tab=` is read once on mount, so a reload keeps the section somebody was on and a link to one
   * of them is a link anybody can send — which is what makes "the Transparency tab says so"
   * something you can pass to another person. An unknown or absent value falls back to the first
   * rather than rendering nothing, so a mistyped link opens Settings instead of a blank panel.
   *
   * Rendering from state rather than from the query is deliberate: switching a tab is a local
   * change, and routing one through the router makes a section of one screen depend on a
   * navigation round trip. The `replace` afterwards is what a reload and a copied link then read.
   */
  const initial = params.get("tab") ?? "";
  const [tab, setTab] = useState(TAB_IDS.includes(initial) ? initial : TABS[0].id);

  const select = useCallback(
    (next: string) => {
      setTab(next);
      const query = new URLSearchParams(params.toString());
      query.set("tab", next);
      // Replace: moving between sections of one screen is not a step to press Back through.
      router.replace(`${pathname}?${query.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  return (
    <section className={styles.screen} aria-label="Settings">
      <header className={styles.heading}>
        <h1 className={styles.title}>Settings</h1>
        <p className={styles.subtitle}>
          Configure how Weathra presents weather, uses AI, remembers your preferences, and handles
          your data.
        </p>
      </header>

      <Tabs
        tabs={TABS}
        activeId={tab}
        onChange={select}
        label="Settings sections"
        idPrefix={TAB_PREFIX}
      />

      <TabPanel id="general" activeId={tab} idPrefix={TAB_PREFIX}>
        <GeneralTab />
      </TabPanel>

      <TabPanel id="intelligence" activeId={tab} idPrefix={TAB_PREFIX}>
        <IntelligenceTab />
      </TabPanel>

      <TabPanel id="account" activeId={tab} idPrefix={TAB_PREFIX}>
        <div className={styles.stack}>
          <AccountIdentity signOutControl={signOutControl} />
          <DeleteAccountData signOutControl={signOutControl} />
        </div>
      </TabPanel>

      <TabPanel id="transparency" activeId={tab} idPrefix={TAB_PREFIX}>
        <TransparencyTab />
      </TabPanel>
    </section>
  );
}
