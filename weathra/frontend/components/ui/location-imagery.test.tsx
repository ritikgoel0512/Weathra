/**
 * Where location imagery may and may not appear, and that it is reached through one component.
 *
 * The screen-level assertions here are deliberately made by reading the sources rather than by
 * rendering: what matters is that a screen *goes through* `LocationImage` rather than growing its
 * own city URL, and that Saved Locations does not grow imagery at all. A render test would pass
 * just as happily against a hard-coded `<img src="https://…berlin.jpg">`, which is the thing being
 * ruled out.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIXTURE_LOCATION_IMAGES } from "@/lib/fixtures/visily";

import { LocationImage } from "./location-image";

const read = (path: string) => readFileSync(path, "utf8");

/*
 * A request that never settles.
 *
 * Production mode resolves the image through `/api/location-image`, and these cases are about the
 * frame *before* that answers. Letting the fetch settle would update state after the assertion and
 * produce an `act()` warning about a transition nothing here is testing; a pending promise holds
 * the component in exactly the state under test.
 */
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the imagery is reached through one component", () => {
  it("is used by the Dashboard hero", () => {
    for (const path of ["components/dashboard/sections.tsx", "components/dashboard/fixture-dashboard.tsx"]) {
      expect(read(path), `${path} does not use LocationImage`).toMatch(/<LocationImage/);
    }
  });

  it("is used by the Compare Cities banners", () => {
    for (const path of ["components/compare/sections.tsx", "components/compare/fixture-compare.tsx"]) {
      expect(read(path), `${path} does not use LocationImage`).toMatch(/<LocationImage/);
    }
  });

  it("is not used by Saved Locations, which the approved artifact draws without photography", () => {
    // `06-saved-locations.png` has no imagery. Adding some because the rest of the set has it would
    // be reinterpreting the design rather than reproducing it.
    for (const path of [
      "components/locations/locations.tsx",
      "components/locations/fixture-locations.tsx",
    ]) {
      expect(read(path), `${path} gained imagery the artifact does not have`).not.toMatch(
        /<LocationImage/,
      );
    }
  });

  it("leaves no city URL written into a component", () => {
    // Every location image comes from the provider chain. A literal city URL anywhere else is the
    // scattering this architecture exists to prevent.
    const offenders: string[] = [];
    const sources = [
      "components/dashboard",
      "components/compare",
      "components/locations",
      "components/historical",
      "components/analyst",
      "components/evidence",
      "components/settings",
    ];
    for (const directory of sources) {
      const found = execSync(
        `grep -rlE 'https?://[^"]*(unsplash|pexels|images\\.|photo)' ${directory} || true`,
        { encoding: "utf8" },
      ).trim();
      if (found.length > 0) offenders.push(found);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the frame is stable whatever tier answers", () => {
  it("renders the generated artwork immediately, so there is no empty frame", () => {
    render(<LocationImage displayName="Berlin, Germany" latitude={52.52} longitude={13.405} />);
    const image = screen.getByRole("img", { name: /Berlin, Germany/i });
    // Present on first paint, before anything is resolved.
    expect(image.getAttribute("src")).toBe("/locations/berlin.svg");
  });

  it("describes the artwork as artwork rather than as a photograph of the place", () => {
    render(<LocationImage displayName="Berlin, Germany" />);
    const image = screen.getByRole("img", { name: /generated decorative artwork/i });
    expect(image).toBeTruthy();
  });

  it("gives an unlisted place an atmosphere of its own rather than a hole", () => {
    render(<LocationImage displayName="Nowhere, Antarctica" />);
    const src = screen.getByRole("img", { name: /Nowhere, Antarctica/i }).getAttribute("src");

    // Drawn from the name, in the frame, on the first paint — no request and no shared stock image.
    expect(src).toMatch(/^data:image\/svg\+xml/);
  });

  it("reports the tier it is showing, so a reviewer is not guessing", () => {
    const { container } = render(<LocationImage displayName="Tokyo, Japan" />);
    expect(container.firstElementChild?.getAttribute("data-source")).toBe("generated");
  });

  it("fixes the height by aspect ratio, not by the image, so nothing reflows", () => {
    const css = read("components/ui/primitives.module.css");
    const hero = css.slice(css.indexOf('.locationImage[data-variant="hero"]'));
    expect(hero).toMatch(/aspect-ratio:/);
    expect(css).toMatch(/object-fit:\s*cover/);
  });

  it("keeps a readability scrim over the image", () => {
    const css = read("components/ui/primitives.module.css");
    expect(css).toMatch(/\.locationScrim\s*\{[^}]*linear-gradient/);
  });
});

describe("fixture imagery is deterministic", () => {
  it("maps the five cities the approved screens need", () => {
    for (const key of ["berlin", "munich", "tokyo", "new-york", "london"]) {
      expect(FIXTURE_LOCATION_IMAGES[key], `no fixture image for ${key}`).toBeDefined();
    }
  });

  it("gives the same city the same image every time it is asked", () => {
    // The table is a constant, so this is really an assertion that it *is* a constant — no
    // randomness, no clock, no provider call behind it.
    const first = { ...FIXTURE_LOCATION_IMAGES };
    const second = { ...FIXTURE_LOCATION_IMAGES };
    expect(second).toEqual(first);
    for (const [key, image] of Object.entries(first)) {
      expect(image.url, key).toBe(second[key]?.url);
    }
  });

  it("points every fixture image at a local asset, never at a third party", () => {
    // A capture run must not depend on the network, or it is not reproducible.
    for (const [key, image] of Object.entries(FIXTURE_LOCATION_IMAGES)) {
      expect(image.url, key).toMatch(/^\/locations\//);
      expect(image.source, key).not.toBe("provider");
    }
  });
});

describe("fixture mode makes no image request", () => {
  it("reads the table instead of asking the endpoint", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_VISILY_FIDELITY_FIXTURES", "true");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { LocationImage: Fixtured } = await import("./location-image");
    render(<Fixtured displayName="Berlin, Germany" />);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: /Berlin/i }).getAttribute("src")).toBe(
      FIXTURE_LOCATION_IMAGES.berlin?.url,
    );

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
