/**
 * The shared candidate chooser — task 21.7's verification of the interaction itself.
 *
 * Every location-entry surface renders this one component, so the properties that matter are
 * asserted once here rather than three times over: that nothing is preselected, that every
 * candidate is reachable and activatable by keyboard alone, that what distinguishes them came out
 * of the response, and that ambiguity, no-match and failure are three different things on screen.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/client";
import type { Location } from "@/lib/api/schema";
import { resolutionOfFailure, type LocationResolution } from "@/lib/locations/resolution";

import { CandidateChoice, CHOICE_REQUIRED_NOTE, CHOICE_REQUIRED_TITLE } from "./candidate-choice";

function place(overrides: Partial<Location> = {}): Location {
  return {
    display_name: "Springfield",
    latitude: 39.8017,
    longitude: -89.6437,
    timezone: "America/Chicago",
    region: "Illinois",
    country: "United States",
    country_code: "US",
    ...overrides,
  } as Location;
}

const ILLINOIS = place();
const MISSOURI = place({ latitude: 37.2153, longitude: -93.2982, region: "Missouri" });

const AMBIGUOUS: LocationResolution = {
  kind: "ambiguous",
  query: "Springfield",
  candidates: [ILLINOIS, MISSOURI],
  message:
    "'Springfield' matches more than one place: Springfield, Illinois, US or Springfield, Missouri, US.",
};

describe("an ambiguous entry", () => {
  it("says a choice is required, and shows the backend's own message", () => {
    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={() => {}} />);

    const panel = screen.getByText(CHOICE_REQUIRED_TITLE).closest("[data-location-state]");
    expect(panel).toHaveAttribute("data-location-state", "ambiguous");
    expect(screen.getByText(AMBIGUOUS.kind === "ambiguous" ? AMBIGUOUS.message : "")).toBeInTheDocument();
    expect(screen.getByText(CHOICE_REQUIRED_NOTE)).toBeInTheDocument();
  });

  /**
   * The question is a heading, at the level the calling screen asks for — task 21.8's manual pass.
   *
   * It was a styled paragraph, which meant somebody navigating by heading could not reach the one
   * question this panel exists to ask. Found by a person driving NVDA; unreachable by every
   * instrument in the automated suite, because those assert properties of the headings that exist
   * and this was a heading that did not.
   */
  it("states the question as a heading, so a heading list can reach it", () => {
    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={() => {}} />);

    const heading = screen.getByRole("heading", { name: CHOICE_REQUIRED_TITLE });
    expect(heading.tagName).toBe("H2");
  });

  it("takes the second level by default, for a screen that places it under its h1", () => {
    // The Dashboard and Compare Cities both do; neither has an h2 before it.
    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={() => {}} />);
    expect(screen.getByRole("heading", { name: CHOICE_REQUIRED_TITLE, level: 2 })).toBeInTheDocument();
  });

  it("takes the third level when a screen nests it inside its own h2 panel", () => {
    // Saved Locations does, inside "Add a location".
    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={() => {}} headingLevel={3} />);
    expect(screen.getByRole("heading", { name: CHOICE_REQUIRED_TITLE, level: 3 })).toBeInTheDocument();
  });

  it("keeps the approved appearance at either level", () => {
    // The artifact specifies one treatment for this title. `styles.title` carries it, and carries it
    // identically at both levels — so the heading change is semantic only.
    const two = render(<CandidateChoice resolution={AMBIGUOUS} onChoose={() => {}} />);
    const atTwo = screen.getByRole("heading", { name: CHOICE_REQUIRED_TITLE }).className;
    two.unmount();

    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={() => {}} headingLevel={3} />);
    const atThree = screen.getByRole("heading", { name: CHOICE_REQUIRED_TITLE }).className;

    expect(atThree).toBe(atTwo);
    expect(atTwo).not.toBe("");
  });

  it("offers one control per candidate, in the backend's order, and preselects none", () => {
    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={() => {}} />);

    const candidates = screen.getAllByRole("button");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toHaveAttribute("data-candidate", "39.8017,-89.6437");
    expect(candidates[1]).toHaveAttribute("data-candidate", "37.2153,-93.2982");

    // Nothing is chosen, checked, focused or otherwise nudged. The first result is exactly the one
    // a geocoder ranks highest, and it is the one Weathra must not pick for anybody.
    for (const candidate of candidates) {
      expect(candidate).not.toHaveAttribute("aria-pressed", "true");
      expect(candidate).not.toBeDisabled();
      expect(candidate).not.toHaveFocus();
    }
    expect(document.body).toHaveFocus();
  });

  it("distinguishes the candidates with fields the response actually supplied", () => {
    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={() => {}} />);

    const [first, second] = screen.getAllByRole("button");
    expect(first).toHaveTextContent("Springfield");
    expect(first).toHaveTextContent("Illinois, United States");
    expect(first).toHaveTextContent("39.8017, -89.6437");
    expect(first).toHaveTextContent("America/Chicago");
    expect(second).toHaveTextContent("Missouri, United States");
    expect(second).toHaveTextContent("37.2153, -93.2982");
  });

  it("shows no placeholder for a field the response did not carry", () => {
    const sparse = place({ region: null, country: null, country_code: null, display_name: "Nowhere" });
    render(
      <CandidateChoice
        resolution={{ kind: "ambiguous", query: "x", candidates: [sparse, MISSOURI], message: "m" }}
        onChoose={() => {}}
      />,
    );

    const first = screen.getAllByRole("button")[0]!;
    expect(first).toHaveTextContent("Nowhere");
    expect(first.textContent).not.toMatch(/not reported|unknown|—/i);
  });

  it("hands back the backend's own candidate object when one is pressed", async () => {
    const onChoose = vi.fn();
    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={onChoose} />);

    await userEvent.setup().click(screen.getAllByRole("button")[1]!);
    expect(onChoose).toHaveBeenCalledTimes(1);
    // The same object, unchanged: no coordinate is reassembled on the way through.
    expect(onChoose.mock.calls[0]?.[0]).toBe(MISSOURI);
  });

  it("is operable by keyboard alone: tab to a candidate, choose with Enter", async () => {
    const onChoose = vi.fn();
    const person = userEvent.setup();
    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={onChoose} />);

    await person.tab();
    expect(screen.getAllByRole("button")[0]).toHaveFocus();
    await person.tab();
    expect(screen.getAllByRole("button")[1]).toHaveFocus();

    await person.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledWith(MISSOURI);
  });

  it("also chooses with Space, as a button does", async () => {
    const onChoose = vi.fn();
    const person = userEvent.setup();
    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={onChoose} />);

    await person.tab();
    await person.keyboard(" ");
    expect(onChoose).toHaveBeenCalledWith(ILLINOIS);
  });

  it("names its group, so several choosers on one screen are told apart", () => {
    render(
      <CandidateChoice resolution={AMBIGUOUS} onChoose={() => {}} label="Places matching location 2" />,
    );
    const group = screen.getByRole("group", { name: "Places matching location 2" });
    expect(within(group).getAllByRole("button")).toHaveLength(2);
  });

  it("disables the candidates while something the choice started is in flight", () => {
    render(<CandidateChoice resolution={AMBIGUOUS} onChoose={() => {}} busy />);
    for (const candidate of screen.getAllByRole("button")) {
      expect(candidate).toBeDisabled();
    }
  });
});

describe("the other answers, kept distinct", () => {
  it("reports no match as no match, with no candidate to choose", () => {
    render(
      <CandidateChoice
        resolution={{ kind: "not-found", query: "Zzzz", message: "No location matches 'Zzzz'." }}
        onChoose={() => {}}
      />,
    );

    const panel = screen.getByRole("alert");
    expect(panel).toHaveAttribute("data-location-state", "not-found");
    expect(panel).toHaveTextContent("No place matches that name");
    expect(panel).toHaveTextContent("No location matches 'Zzzz'.");
    expect(screen.queryByText(CHOICE_REQUIRED_TITLE)).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("reports a failed lookup as a failure, never as no match or as ambiguity", () => {
    const onRetry = vi.fn();
    render(
      <CandidateChoice
        resolution={resolutionOfFailure(
          "Berlin",
          new ApiError(500, { code: "internal_error", message: "The geocoder did not answer." }),
        )}
        onChoose={() => {}}
        onRetry={onRetry}
      />,
    );

    const panel = screen.getByRole("alert");
    expect(panel.closest("[data-location-state]")).toHaveAttribute("data-location-state", "failed");
    expect(panel).toHaveTextContent("That location could not be looked up");
    expect(panel).toHaveTextContent("The geocoder did not answer.");
    expect(screen.queryByText("No place matches that name")).toBeNull();
    expect(screen.queryByText(CHOICE_REQUIRED_TITLE)).toBeNull();
    expect(within(panel).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("says it is looking, while it is looking", () => {
    render(
      <CandidateChoice resolution={{ kind: "resolving", query: "Berlin" }} onChoose={() => {}} />,
    );
    const panel = screen.getByRole("status");
    expect(panel).toHaveAttribute("data-location-state", "resolving");
    expect(panel).toHaveTextContent(/Resolving .Berlin./);
  });

  it("renders nothing at all for an unresolved or already-resolved entry", () => {
    const { container: idle } = render(
      <CandidateChoice resolution={{ kind: "unresolved" }} onChoose={() => {}} />,
    );
    expect(idle).toBeEmptyDOMElement();

    const { container: done } = render(
      <CandidateChoice
        resolution={{ kind: "resolved", query: "Berlin", location: ILLINOIS, chosen: true }}
        onChoose={() => {}}
      />,
    );
    expect(done).toBeEmptyDOMElement();
  });
});
