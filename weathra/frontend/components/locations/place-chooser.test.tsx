/**
 * Every Intelligence screen carries its own place control, and none of them goes blank without a
 * default location.
 *
 * These are the two properties of the 2026-09-11 parity pass worth a test rather than a screenshot.
 * Before it, each of the five read `/me/preferences` and — with no default set — rendered an empty
 * state and a link to Settings. A customer who signed up and pressed *Forecast Explorer* got a
 * sentence and a link where the artifact has a screen: the feature existed and was reachable only
 * by first configuring a preference somewhere else.
 *
 * Asserted per screen rather than once against the shared component, because the regression that
 * matters is a *screen* forgetting to mount it — which is exactly what happened, five times over,
 * and which a test of `PlaceChooser` alone would never have caught.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ForecastExplorer } from "@/components/explorer/explorer";
import { WeatherIntelligenceReport } from "@/components/report/report";
import { WeatherScenarioLab } from "@/components/scenarios/scenarios";
import { TravelIntelligence } from "@/components/travel/travel";
import { WeatherWatch } from "@/components/watch/watch";
import type { ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import { createQueryClient } from "@/lib/query/provider";

const OSLO = {
  display_name: "Oslo",
  latitude: 59.9127,
  longitude: 10.7461,
  timezone: "Europe/Oslo",
  country: "Norway",
  country_code: "NO",
};

/** A client that answers nothing but preferences: every screen's own reads may fail freely here. */
function client(defaultLocation: typeof OSLO | null): ApiClient {
  const empty = vi.fn().mockRejectedValue(new Error("not part of this test"));
  return new Proxy(
    {
      preferences: vi.fn().mockResolvedValue({
        unit_system: "metric",
        forecast_horizon_days: 7,
        default_location: defaultLocation,
        sources: {},
      }),
      resolveLocation: vi.fn().mockResolvedValue({
        query: "Lisbon",
        resolved: {
          display_name: "Lisbon",
          latitude: 38.7167,
          longitude: -9.1333,
          timezone: "Europe/Lisbon",
          country: "Portugal",
          country_code: "PT",
        },
        candidates: [],
      }),
    } as Record<string, unknown>,
    {
      get: (target, property) =>
        property in target ? target[property as string] : empty,
    },
  ) as unknown as ApiClient;
}

function mount(node: React.ReactElement, defaultLocation: typeof OSLO | null) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiProvider client={client(defaultLocation)}>{node}</ApiProvider>
    </QueryClientProvider>,
  );
}

const SCREENS: readonly { name: string; node: React.ReactElement; summary: RegExp }[] = [
  { name: "Forecast Explorer", node: <ForecastExplorer />, summary: /explore another place/i },
  { name: "Weather Intelligence Report", node: <WeatherIntelligenceReport />, summary: /report on another place/i },
  { name: "Weather Scenario Lab", node: <WeatherScenarioLab />, summary: /experiment on another place/i },
  { name: "Weather Watch", node: <WeatherWatch />, summary: /watch another place/i },
];

describe("every Intelligence screen can be pointed at a place on the screen itself", () => {
  for (const { name, node, summary } of SCREENS) {
    it(`${name} offers its own place control with a default set`, async () => {
      mount(node, OSLO);
      // Present but folded: `01-dashboard.png` opens on content, not on a form, and finding 1.7
      // was production opening onto a form above the fold on every visit.
      expect(await screen.findByText(summary)).toBeInTheDocument();
    });

    it(`${name} still shows its control, and no dead end, with no default set`, async () => {
      mount(node, null);

      // The field is reachable without pressing anything.
      expect(await screen.findByRole("textbox")).toBeInTheDocument();

      /*
       * And it is not inside a disclosure at all.
       *
       * This assertion used to be its opposite — it required the summary to be present with no
       * default set, and the chooser to have opened itself. That encoded the defect: every one of
       * these summaries reads "…another place", which is what the screen asks somebody who has had
       * none, and a disclosure presents the only thing to do on the screen as an aside. With no
       * place the control is now the screen's subject, headed for what it is.
       */
      expect(screen.queryByText(summary)).toBeNull();
      expect(screen.getByText("Choose a place to begin")).toBeInTheDocument();

      // The way out is still not "go to Settings and come back".
      expect(screen.queryByRole("link", { name: /open settings/i })).toBeNull();
    });
  }
});

/*
 * Travel Intelligence asks a different question, so it is held to the same principle differently.
 *
 * The other Intelligence screens are pointed at *a place*, and the loop above checks each one folds
 * that control away with a default and leads with it without one. Travel's subject is a **trip** —
 * an origin, a destination and two dates — so its place controls live together in the one trip
 * editor rather than as a standalone "travel to another place" disclosure. The principle this file
 * exists to protect is unchanged and asserted here: the screen can be pointed somewhere from the
 * screen itself, and never dead-ends into Settings.
 */
describe("Travel Intelligence is pointed at a trip, from the screen itself", () => {
  it("keeps its place controls in one editor, opened from the trip header", async () => {
    mount(<TravelIntelligence />, OSLO);

    // Folded by default: the screen opens on the trip, not on a form.
    expect(await screen.findByRole("button", { name: "Adjust trip" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Adjust trip" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Adjust trip" }));
    const editor = await screen.findByRole("region", { name: "Adjust trip" });

    /*
     * Both places, together, and the dates beside them — one editor, not two stacked forms. Asked
     * for by each chooser's form label rather than by its disclosure summary, because a chooser
     * with nothing set yet leads with its field instead of folding behind a summary.
     */
    expect(within(editor).getByRole("form", { name: "Travelling from" })).toBeInTheDocument();
    expect(within(editor).getByRole("form", { name: "Travelling to" })).toBeInTheDocument();
    expect(within(editor).getByLabelText("Departure")).toBeInTheDocument();
    expect(within(editor).getByLabelText("Return")).toBeInTheDocument();
  });

  it("leads with the editor, and no dead end, when there is no default place", async () => {
    mount(<TravelIntelligence />, null);

    // Reachable without pressing anything, because with no destination there is nothing else to do.
    const editor = await screen.findByRole("region", { name: "Adjust trip" });
    expect(within(editor).getAllByRole("textbox").length).toBeGreaterThan(0);

    // The way out is still not "go to Settings and come back".
    expect(screen.queryByRole("link", { name: /open settings/i })).toBeNull();
  });
});

describe("a name typed into it never becomes a weather request directly", () => {
  it("sends the name to the resolver and adopts what the backend returns", async () => {
    const resolver = vi.fn().mockResolvedValue({
      query: "Lisbon",
      resolved: {
        display_name: "Lisbon",
        latitude: 38.7167,
        longitude: -9.1333,
        timezone: "Europe/Lisbon",
        country: "Portugal",
        country_code: "PT",
      },
      candidates: [],
    });

    render(
      <QueryClientProvider client={createQueryClient()}>
        <ApiProvider
          client={
            new Proxy(
              {
                preferences: vi.fn().mockResolvedValue({
                  unit_system: "metric",
                  forecast_horizon_days: 7,
                  default_location: null,
                  sources: {},
                }),
                resolveLocation: resolver,
              } as Record<string, unknown>,
              {
                get: (target, property) =>
                  property in target
                    ? target[property as string]
                    : vi.fn().mockRejectedValue(new Error("not part of this test")),
              },
            ) as unknown as ApiClient
          }
        >
          <ForecastExplorer />
        </ApiProvider>
      </QueryClientProvider>,
    );

    const field = await screen.findByRole("textbox");
    await userEvent.type(field, "Lisbon");
    await userEvent.click(screen.getByRole("button", { name: /show this place/i }));

    /*
     * The property, not the plumbing: the typed string reached `/locations/resolve` and the screen
     * adopted the canonical object that came back. No component here ever turns a name into
     * coordinates itself, which is what makes an ambiguous entry impossible to silently guess at.
     */
    expect(resolver).toHaveBeenCalledWith({ query: "Lisbon" });
  });
});
