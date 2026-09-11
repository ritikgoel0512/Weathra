/**
 * The provenance primitives — task 20.15's verification.
 *
 * The task asks that each renders its label and that interpretation is distinguishable from
 * retrieved data. Those are here, and so are the ones that are honesty properties rather than
 * appearance: that no component invents a provider, a station, a model name or a number; that a
 * confidence band never arrives without its basis; that an analytics figure says Weathra computed
 * it; and that the three tiers are separate regions rather than three paragraphs.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DATA_CLASS_NAMES } from "@/lib/design/tokens";

import { DATA_CLASS_DESCRIPTIONS, DATA_CLASS_LABELS, DataClassBadge } from "./badge";
import {
  AttributionFooter,
  COMPUTED_BY_WEATHRA,
  INTERPRETATION_BOUNDARY,
  InterpretationPanel,
  MethodNote,
  NO_SPREAD_AVAILABLE,
  NOT_REPORTED,
  ProvenanceSection,
  UncertaintyIndicator,
  formatInstant,
  formatLocalStamp,
  type Attribution,
} from "./provenance";

/** Attribution as a backend response carries it. No name here appears in any component. */
const ATTRIBUTION: Attribution = {
  provider: "open-meteo",
  location: "Berlin, Germany",
  retrievedAt: "2026-09-04T06:15:30Z",
  period: { start: "2026-09-04T00:00:00+02:00", end: "2026-09-11T00:00:00+02:00", timezone: "Europe/Berlin" },
  units: "metric",
  fromCache: false,
};

describe("the five data classes", () => {
  it("renders the label for each one", () => {
    for (const dataClass of DATA_CLASS_NAMES) {
      const view = render(<DataClassBadge dataClass={dataClass} />);
      expect(screen.getByText(DATA_CLASS_LABELS[dataClass]), dataClass).toBeInTheDocument();
      view.unmount();
    }
  });

  it("names the five the design system fixes, and spells interpretation one way", () => {
    expect(Object.values(DATA_CLASS_LABELS)).toEqual([
      "OBSERVED",
      "FORECAST",
      "HISTORICAL",
      "ANALYTICS",
      "AI INTERPRETATION",
    ]);
  });

  it("carries its class on the element, not only in a generated class name", () => {
    const { container } = render(<DataClassBadge dataClass="historical" />);
    expect(container.querySelector('[data-class="historical"]')).toBeInTheDocument();
  });

  it("says in words what each class means, so the badge is never colour alone", () => {
    for (const dataClass of DATA_CLASS_NAMES) {
      const view = render(<DataClassBadge dataClass={dataClass} />);
      expect(screen.getByText(DATA_CLASS_LABELS[dataClass])).toHaveAttribute(
        "title",
        DATA_CLASS_DESCRIPTIONS[dataClass],
      );
      view.unmount();
    }
  });

  it("describes analytics as Weathra's own computation and interpretation as a model's writing", () => {
    // The two sentences the interface must never blur.
    expect(DATA_CLASS_DESCRIPTIONS.analytics).toMatch(/computed deterministically by Weathra/i);
    expect(DATA_CLASS_DESCRIPTIONS.interpretation).toMatch(/language model/i);
    expect(DATA_CLASS_DESCRIPTIONS.interpretation).toMatch(/did not produce/i);
  });
});

describe("attribution", () => {
  it("shows the provider, location, period and retrieval time", () => {
    render(<AttributionFooter attribution={ATTRIBUTION} />);

    // The provider and the retrieval time appear twice on purpose: once in the summary a person
    // reads without opening anything, and once in the description list under it. A summary that
    // previewed neither would be a disclosure worth nothing, and the rows are what `specs/web-ui`
    // requires the surface to carry.
    expect(screen.getAllByText("open-meteo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Berlin, Germany")).toBeInTheDocument();
    expect(screen.getByText(/2026-09-04 00:00 to 2026-09-11 00:00/)).toBeInTheDocument();
    expect(screen.getByText(/Europe\/Berlin/)).toBeInTheDocument();
    expect(screen.getAllByText("2026-09-04 06:15 UTC").length).toBeGreaterThanOrEqual(1);
  });

  it("labels every field, as name and value pairs", () => {
    const { container } = render(<AttributionFooter attribution={ATTRIBUTION} />);

    for (const term of ["Source", "Location", "Period", "Retrieved", "Units"]) {
      expect(screen.getByText(term), term).toBeInTheDocument();
    }
    expect(container.querySelector("dl")).toBeInTheDocument();
    expect(container.querySelectorAll("dt")).toHaveLength(5);
  });

  it("carries the machine-readable instant alongside the readable one", () => {
    const { container } = render(<AttributionFooter attribution={ATTRIBUTION} />);
    expect(container.querySelector("time")).toHaveAttribute("datetime", "2026-09-04T06:15:30Z");
  });

  it("says a field was not reported rather than inventing one", () => {
    // No default provider, no placeholder station, no plausible-looking stand-in.
    render(<AttributionFooter attribution={{}} />);

    // Five: the four description rows that have nothing to report, and the summary's own preview
    // of the provider.
    expect(screen.getAllByText(NOT_REPORTED)).toHaveLength(5);
    expect(document.body.textContent ?? "").not.toMatch(/station|WMO|synop/i);
  });

  /*
   * Finding 2.11 of the runtime fidelity audit of 2026-09-08, and the `specs/web-ui` clarification
   * of 2026-09-09: a surface bearing no weather value may not display a weather provenance field
   * that does not apply to it — as a value or as unreported — and must still identify what
   * produced it. The weather-bearing footer above is unchanged, and the tests above it are the
   * proof of that: they are the guarantee this narrowing must not reach.
   */
  describe("a surface that bears no weather value (2.11)", () => {
    it("shows what produced it and when, and no weather provenance field at all", () => {
      const { container } = render(
        <AttributionFooter
          scope="model-run"
          attribution={{
            provider: "openrouter",
            model: "nvidia/nemotron-3-super-120b-a12b:free",
            completedAt: "2026-09-04T06:15:30Z",
          }}
        />,
      );

      expect(screen.getByText("Produced by")).toBeInTheDocument();
      expect(
        screen.getByText("openrouter · nvidia/nemotron-3-super-120b-a12b:free"),
      ).toBeInTheDocument();
      expect(screen.getByText("Completed")).toBeInTheDocument();

      // The four that do not describe a language-model run — absent, not "not reported".
      for (const term of ["Source", "Location", "Period", "Retrieved", "Units"]) {
        expect(screen.queryByText(term), term).not.toBeInTheDocument();
      }
      expect(screen.queryByText(NOT_REPORTED)).not.toBeInTheDocument();
      expect(container.querySelectorAll("dt")).toHaveLength(2);
    });

    it("omits a row the backend did not report rather than saying it is unreported", () => {
      // "not reported" about a field that could never apply is the same fabrication, quieter.
      render(<AttributionFooter scope="model-run" attribution={{}} />);

      expect(screen.queryByText(NOT_REPORTED)).not.toBeInTheDocument();
      expect(document.querySelectorAll("dt")).toHaveLength(0);
    });

    it("is marked as its own scope, so the distinction does not depend on which rows a run filled", () => {
      const { container } = render(
        <AttributionFooter scope="model-run" attribution={{ provider: "openrouter" }} />,
      );

      expect(container.querySelector("[data-attribution]")).toHaveAttribute(
        "data-attribution-scope",
        "model-run",
      );
    });

    it("leaves the weather-bearing footer carrying all four, unreported and all", () => {
      const { container } = render(<AttributionFooter attribution={{}} />);

      // The default scope is unchanged and is not the narrowed one.
      expect(container.querySelector("[data-attribution]")).not.toHaveAttribute(
        "data-attribution-scope",
      );
      expect(screen.getAllByText(NOT_REPORTED)).toHaveLength(5);
    });
  });

  it("treats a blank provider as unreported", () => {
    render(<AttributionFooter attribution={{ ...ATTRIBUTION, provider: "   " }} />);
    // In the summary and in the row beneath it: a blank provider is unreported in both places.
    expect(screen.getAllByText(NOT_REPORTED)).toHaveLength(2);
  });

  it("says when a figure came from the cache rather than the provider just now", () => {
    render(<AttributionFooter attribution={{ ...ATTRIBUTION, fromCache: true }} />);
    expect(screen.getByText(/from Weathra’s cache/)).toBeInTheDocument();
  });

  it("reads the period in the location's own timezone, never the reader's", () => {
    // Parsed as text: re-expressing a Berlin window in the reader's zone and calling it the period
    // covered would be a quiet lie.
    expect(formatLocalStamp("2026-09-04T00:00:00+02:00")).toBe("2026-09-04 00:00");
    expect(formatInstant("2026-09-04T06:15:30Z")).toBe("2026-09-04 06:15 UTC");
    expect(formatInstant("not a time")).toBeNull();
    expect(formatLocalStamp(undefined)).toBeNull();
  });
});

describe("uncertainty", () => {
  const BASIS =
    "Confidence decreases with horizon distance. Derived from one provider's output and its supplied spread only.";

  it("states the band in words and shows the basis with it", () => {
    render(<UncertaintyIndicator confidence="moderate" basis={BASIS} hoursAhead={72} />);

    expect(screen.getByText("MODERATE CONFIDENCE")).toBeInTheDocument();
    expect(screen.getByText(BASIS)).toBeInTheDocument();
    expect(screen.getByText(/72 h into the forecast horizon/)).toBeInTheDocument();
  });

  it("renders each band with its own word, so the level never rests on colour", () => {
    for (const [confidence, label] of [
      ["high", "HIGH CONFIDENCE"],
      ["moderate", "MODERATE CONFIDENCE"],
      ["low", "LOW CONFIDENCE"],
    ] as const) {
      const view = render(<UncertaintyIndicator confidence={confidence} basis={BASIS} />);
      expect(screen.getByText(label), confidence).toBeInTheDocument();
      view.unmount();
    }
  });

  it("shows no interval, percentage, or ± figure", () => {
    // Weathra reads one provider's output. A number here would be precision it does not have.
    render(<UncertaintyIndicator confidence="low" basis={BASIS} hoursAhead={168} />);

    const shown = document.body.textContent ?? "";
    expect(shown).not.toMatch(/±/);
    expect(shown).not.toMatch(/\d+\s?%/);
    expect(shown).not.toMatch(/\bp\d{2}\b|confidence interval/i);
  });

  it("says when the provider supplies no spread instead of deriving one", () => {
    render(<UncertaintyIndicator confidence="low" basis={BASIS} spreadAvailable={false} />);
    expect(screen.getByText(NO_SPREAD_AVAILABLE)).toBeInTheDocument();
  });

  it("says nothing about spread when the backend did not say", () => {
    render(<UncertaintyIndicator confidence="high" basis={BASIS} />);
    expect(screen.queryByText(NO_SPREAD_AVAILABLE)).not.toBeInTheDocument();
  });

  it("omits the horizon distance when it was not measured", () => {
    render(<UncertaintyIndicator confidence="high" basis={BASIS} />);
    expect(screen.queryByText(/forecast horizon/)).not.toBeInTheDocument();
  });
});

describe("the analytics method note", () => {
  it("says Weathra computed it, and names the method", () => {
    render(<MethodNote method="least-squares slope" pointsUsed={30} unit="°C/day" />);

    expect(screen.getByText(COMPUTED_BY_WEATHRA)).toBeInTheDocument();
    expect(screen.getByText("Method: least-squares slope.")).toBeInTheDocument();
    expect(screen.getByText("30 points used.")).toBeInTheDocument();
    expect(screen.getByText("Unit: °C/day.")).toBeInTheDocument();
  });

  it("says the figure is deterministic, not a model's output", () => {
    render(<MethodNote method="median absolute deviation" />);
    expect(screen.getByText(COMPUTED_BY_WEATHRA)).toHaveTextContent(/deterministically/i);
    expect(document.body.textContent ?? "").not.toMatch(/language model|generated|predicted by/i);
  });

  it("reports excluded points rather than folding them in as zero", () => {
    render(<MethodNote method="arithmetic mean of usable points" pointsUsed={22} pointsExcluded={2} />);
    expect(screen.getByText("2 excluded as absent.")).toBeInTheDocument();
  });

  it("says why a statistic was not computable instead of showing a figure", () => {
    render(<MethodNote method="trend" reason="fewer than the declared minimum points" />);
    expect(screen.getByText(/Why: fewer than the declared minimum points\./)).toBeInTheDocument();
  });
});

describe("AI interpretation", () => {
  it("carries its badge and states what it is, above the prose", () => {
    render(<InterpretationPanel>The week trends warmer than the ten-year mean.</InterpretationPanel>);

    const panel = screen.getByRole("region", { name: "AI interpretation" });
    expect(within(panel).getByText("AI INTERPRETATION")).toBeInTheDocument();
    expect(within(panel).getByText(INTERPRETATION_BOUNDARY)).toBeInTheDocument();
    expect(within(panel).getByText(/trends warmer/)).toBeInTheDocument();
  });

  it("says plainly that the model produced no measurement", () => {
    render(<InterpretationPanel>Prose.</InterpretationPanel>);
    expect(screen.getByText(INTERPRETATION_BOUNDARY)).toHaveTextContent(
      /produced no measurement, forecast, or statistic/i,
    );
  });

  it("keeps that sentence whatever the screen titles the panel", () => {
    // The boundary is a constant, not a prop: a screen that could soften it would.
    render(<InterpretationPanel title="What this means">Prose.</InterpretationPanel>);

    const panel = screen.getByRole("region", { name: "What this means" });
    expect(within(panel).getByText(INTERPRETATION_BOUNDARY)).toBeInTheDocument();
  });

  it("attributes only the model the backend reported", () => {
    render(
      <InterpretationPanel provider="openrouter" model="nvidia/nemotron-nano-9b-v2:free">
        Prose.
      </InterpretationPanel>,
    );
    expect(screen.getByText("Model: openrouter · nvidia/nemotron-nano-9b-v2:free")).toBeInTheDocument();
  });

  it("names no model at all when the backend reported none", () => {
    render(<InterpretationPanel>Prose.</InterpretationPanel>);
    expect(screen.queryByText(/^Model:/)).not.toBeInTheDocument();
    // No invented agent version strings either.
    expect(document.body.textContent ?? "").not.toMatch(/v\d+\.\d+|neural agent/i);
  });

  it("is marked as interpretation on the element itself", () => {
    const { container } = render(<InterpretationPanel>Prose.</InterpretationPanel>);
    const panel = container.querySelector('[data-interpretation="true"]');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute("data-tier", "interpretation");
    expect(panel).toHaveAttribute("data-class", "interpretation");
  });
});

describe("the separation between retrieved data, calculation, and interpretation", () => {
  function screenWithAllThree() {
    return render(
      <div>
        <ProvenanceSection dataClass="forecast" title="Seven-day forecast" attribution={ATTRIBUTION}>
          <p>Tuesday 21°C</p>
        </ProvenanceSection>

        <ProvenanceSection dataClass="analytics" title="Computed statistics">
          <p>Mean 18.4°C</p>
          <MethodNote method="arithmetic mean of usable points" pointsUsed={168} />
        </ProvenanceSection>

        <InterpretationPanel>A mild week with one warm spell midweek.</InterpretationPanel>
      </div>,
    );
  }

  it("renders three separate regions, one per tier", () => {
    const { container } = screenWithAllThree();

    expect(container.querySelectorAll('[data-tier="retrieved"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-tier="computed"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-tier="interpretation"]')).toHaveLength(1);
  });

  it("keeps the model's language outside the region holding the figures", () => {
    const { container } = screenWithAllThree();

    const retrieved = container.querySelector('[data-tier="retrieved"]') as HTMLElement;
    const computed = container.querySelector('[data-tier="computed"]') as HTMLElement;
    const interpretation = container.querySelector('[data-tier="interpretation"]') as HTMLElement;

    expect(within(retrieved).getByText("Tuesday 21°C")).toBeInTheDocument();
    expect(within(computed).getByText("Mean 18.4°C")).toBeInTheDocument();
    expect(within(interpretation).getByText(/A mild week/)).toBeInTheDocument();

    // The prose is in none of the regions that hold a number, and no number is in its region.
    expect(within(retrieved).queryByText(/A mild week/)).not.toBeInTheDocument();
    expect(within(computed).queryByText(/A mild week/)).not.toBeInTheDocument();
    expect(interpretation.contains(retrieved)).toBe(false);
    expect(interpretation.contains(computed)).toBe(false);
  });

  it("badges each region with its own class", () => {
    const { container } = screenWithAllThree();

    const retrieved = container.querySelector('[data-tier="retrieved"]') as HTMLElement;
    const computed = container.querySelector('[data-tier="computed"]') as HTMLElement;
    const interpretation = container.querySelector('[data-tier="interpretation"]') as HTMLElement;

    expect(within(retrieved).getByText("FORECAST")).toBeInTheDocument();
    expect(within(computed).getByText("ANALYTICS")).toBeInTheDocument();
    expect(within(interpretation).getByText("AI INTERPRETATION")).toBeInTheDocument();
  });

  it("keeps a forecast region distinguishable from a historical one", () => {
    const { container } = render(
      <div>
        <ProvenanceSection dataClass="forecast" title="Ahead">
          <p>21°C</p>
        </ProvenanceSection>
        <ProvenanceSection dataClass="historical" title="Behind">
          <p>19°C</p>
        </ProvenanceSection>
      </div>,
    );

    expect(container.querySelector('[data-class="forecast"][data-tier="retrieved"]')).toBeInTheDocument();
    expect(container.querySelector('[data-class="historical"][data-tier="retrieved"]')).toBeInTheDocument();
    expect(screen.getByText("FORECAST")).toBeInTheDocument();
    expect(screen.getByText("HISTORICAL")).toBeInTheDocument();
  });

  it("routes an interpretation class to the one interpretation treatment", () => {
    // However a screen asks for it, the model's language gets the same panel and the same sentence.
    render(
      <ProvenanceSection dataClass="interpretation" title="Reading">
        Prose.
      </ProvenanceSection>,
    );

    expect(screen.getByRole("region", { name: "Reading" })).toHaveAttribute(
      "data-interpretation",
      "true",
    );
    expect(screen.getByText(INTERPRETATION_BOUNDARY)).toBeInTheDocument();
  });

  it("names each region, so it is a landmark rather than a box", () => {
    screenWithAllThree();

    expect(screen.getByRole("region", { name: "Seven-day forecast" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Computed statistics" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "AI interpretation" })).toBeInTheDocument();
  });

  it("shows the attribution inside the region it belongs to", () => {
    const { container } = screenWithAllThree();

    const retrieved = container.querySelector('[data-tier="retrieved"]') as HTMLElement;
    // Named in the summary and again in the row below it; both are inside this region, which is
    // what the assertion is about.
    expect(within(retrieved).getAllByText("open-meteo").length).toBeGreaterThanOrEqual(1);
    expect(retrieved.querySelector('[data-attribution="true"]')).toBeInTheDocument();
  });
});

describe("what these primitives never say", () => {
  it("ships no provider name, station identifier, or model version of their own", () => {
    // §15: the mock sources in the artifacts are mockup filler and are not implemented.
    render(
      <div>
        <ProvenanceSection dataClass="observed" title="Now" attribution={{}}>
          <p>—</p>
        </ProvenanceSection>
        <InterpretationPanel>Prose.</InterpretationPanel>
        <UncertaintyIndicator confidence="high" basis="Stated basis." />
        <MethodNote method="mean" />
      </div>,
    );

    const shown = document.body.textContent ?? "";
    for (const invented of [
      "NOAA",
      "MeteoGroup",
      "WMO",
      "station",
      "Aris Thorne",
      "audit chain",
      "tamper",
      "recalibrat",
    ]) {
      expect(shown.toLowerCase(), invented).not.toContain(invented.toLowerCase());
    }
  });

  it("never suggests the model produced a figure", () => {
    render(
      <ProvenanceSection dataClass="analytics" title="Computed">
        <MethodNote method="median absolute deviation" pointsUsed={30} />
      </ProvenanceSection>,
    );

    const shown = document.body.textContent ?? "";
    expect(shown).toContain(COMPUTED_BY_WEATHRA);
    expect(shown).not.toMatch(/AI INTERPRETATION/);
  });
});

describe("where a method sentence lives", () => {
  /**
   * The Dashboard printed "median absolute deviation with a materiality floor…" beside every
   * computed figure, because the method was the `<summary>` of its own disclosure. The arithmetic
   * has to stay available — `specs/safety-grounding` requires it — but it is level-3 detail and it
   * was the first thing on a weather screen.
   */
  it("shows an affordance rather than the methodology, and still carries the methodology", () => {
    render(<MethodNote method="median absolute deviation over a 30-day window" pointsUsed={30} />);

    const summary = document.querySelector("summary")!;
    expect(summary.textContent).toContain("View analysis");
    expect(summary.textContent).not.toContain("median absolute deviation");

    // Not removed: still in the note, one disclosure level down.
    const note = document.querySelector('[data-method-note="true"]')!;
    expect(note.textContent).toContain("median absolute deviation over a 30-day window");
    expect(note.textContent).toContain("30 points used");
  });
});
