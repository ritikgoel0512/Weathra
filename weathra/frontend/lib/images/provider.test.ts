// @vitest-environment node
//
// Node, not jsdom: `provider.server.ts` refuses to load where a `window` exists, which is the whole
// point of it — so the suite that exercises it has to run somewhere that does not have one. The
// browser-refusal case below stands a `window` up deliberately.
/**
 * The provider chain: what happens when there is no credential, and what never leaves the server.
 *
 * The no-credential path is the one this environment actually runs in, so it is the one most worth
 * asserting: with nothing configured, every place must still resolve, to artwork, without a network
 * request. A test that only covered the configured path would pass while the shipped behaviour was
 * broken.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { locationKey } from "./locations";

const KEYS = [
  "CITY_IMAGE_PROVIDER",
  "PEXELS_API_KEY",
  "UNSPLASH_ACCESS_KEY",
  "CITY_IMAGE_COMMONS",
] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Fresh module per case, because the configuration is read at call time from `process.env`. */
async function load() {
  return import("./provider.server");
}

describe("with no provider configured and Commons switched off", () => {
  beforeEach(() => {
    delete process.env.CITY_IMAGE_PROVIDER;
    delete process.env.PEXELS_API_KEY;
    delete process.env.UNSPLASH_ACCESS_KEY;
    /*
     * The keyless tier is on by default, which is the point of it — so a suite asserting "no
     * network request at all" has to switch it off to be asserting anything. Its own behaviour is
     * the block further down.
     */
    process.env.CITY_IMAGE_COMMONS = "off";
  });

  it("reports itself unconfigured rather than pretending", async () => {
    const { providerConfigured } = await load();
    expect(providerConfigured()).toBe(false);
  });

  it("still resolves every place, to the generated artwork", async () => {
    const { resolveLocationImage } = await load();
    for (const place of ["Berlin, Germany", "Munich, Germany", "Nowhere-at-all"]) {
      const image = await resolveLocationImage(place);
      expect(image.source, place).toBe("generated");
      // A committed drawing for a listed place, an atmosphere derived from the name otherwise.
      // Both are the generated tier, and neither needs a credential or a network request.
      expect(image.url, place).toMatch(/^(\/locations\/[a-z-]+\.svg|data:image\/svg\+xml)/);
    }
  });

  it("makes no network request at all", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { resolveLocationImage } = await load();
    await resolveLocationImage("Berlin, Germany");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("with a provider named but no key", () => {
  beforeEach(() => {
    process.env.CITY_IMAGE_COMMONS = "off";
  });

  it("falls through rather than calling the provider unauthenticated", async () => {
    process.env.CITY_IMAGE_PROVIDER = "pexels";
    delete process.env.PEXELS_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { providerConfigured, resolveLocationImage } = await load();

    expect(providerConfigured()).toBe(false);
    expect((await resolveLocationImage("Berlin, Germany")).source).toBe("generated");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a blank key as no key", async () => {
    process.env.CITY_IMAGE_PROVIDER = "unsplash";
    process.env.UNSPLASH_ACCESS_KEY = "   ";
    const { providerConfigured } = await load();
    expect(providerConfigured()).toBe(false);
  });
});

describe("with a provider configured", () => {
  beforeEach(() => {
    process.env.CITY_IMAGE_PROVIDER = "pexels";
    process.env.PEXELS_API_KEY = "test-key-not-a-real-one";
    // These cases are about the configured provider's own chain. The keyless tier below it would
    // otherwise answer every "falls back to artwork" case with a photograph and hide the point.
    process.env.CITY_IMAGE_COMMONS = "off";
  });

  const photos = [
    { id: 300, alt: "third", src: { large2x: "https://example.test/c.jpg" } },
    { id: 100, alt: "first", src: { large2x: "https://example.test/a.jpg" } },
    { id: 200, alt: "second", src: { large2x: "https://example.test/b.jpg" } },
  ];

  it("sends the key as a header, never in the URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ photos }), { status: 200 }));
    const { resolveLocationImage } = await load();
    await resolveLocationImage("Berlin, Germany");

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("test-key-not-a-real-one");
    expect((init?.headers as Record<string, string>).Authorization).toBe("test-key-not-a-real-one");
  });

  it("chooses the same photograph however the provider orders its results", async () => {
    const forOrder = async (ordered: typeof photos) => {
      vi.resetModules();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ photos: ordered }), { status: 200 }),
      );
      const { resolveLocationImage, resetLocationImageCache } = await load();
      resetLocationImageCache();
      return (await resolveLocationImage("Berlin, Germany")).url;
    };

    // Same set, three orders. A `results[0]` implementation would give three different answers.
    const first = await forOrder(photos);
    const second = await forOrder([...photos].reverse());
    const third = await forOrder([photos[1]!, photos[2]!, photos[0]!]);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("asks the provider once per place, then serves the remembered answer", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ photos }), { status: 200 }));
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();

    await resolveLocationImage("Berlin, Germany");
    await resolveLocationImage("Berlin, DE");
    await resolveLocationImage("Berlin");

    // Three spellings, one place, one request — which is what `locationKey` is for.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to artwork when the provider refuses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 429 }));
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();
    expect((await resolveLocationImage("Berlin, Germany")).source).toBe("generated");
  });

  it("falls back to artwork when the provider is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND"));
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();
    expect((await resolveLocationImage("Berlin, Germany")).source).toBe("generated");
  });

  it("falls back to artwork when the provider answers with nothing usable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ photos: [] }), { status: 200 }),
    );
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();
    expect((await resolveLocationImage("Berlin, Germany")).source).toBe("generated");
  });

  it("carries the photographer's credit through, for the licence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          photos: [
            {
              id: 1,
              alt: "a city",
              photographer: "A Photographer",
              photographer_url: "https://example.test/who",
              src: { large2x: "https://example.test/one.jpg" },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();
    const image = await resolveLocationImage("Berlin, Germany");
    expect(image.source).toBe("provider");
    expect(image.credit?.name).toBe("A Photographer");
  });
});


/**
 * The keyless tier — task 21.9's answer to "real photography without a paid service".
 *
 * Every case here mocks the two Wikimedia calls rather than making them, so the suite stays
 * offline and deterministic. What it asserts is the part that matters legally as much as visually:
 * a photograph is shown only when the file's own metadata names a licence, and the photographer
 * and licence that reach the screen are the metadata's, never composed here.
 */
describe("the keyless Wikimedia tier", () => {
  beforeEach(() => {
    delete process.env.CITY_IMAGE_PROVIDER;
    delete process.env.PEXELS_API_KEY;
    delete process.env.UNSPLASH_ACCESS_KEY;
    delete process.env.CITY_IMAGE_COMMONS;
  });

  /** The two answers the chain makes, in order: the article's lead image, then that file's record. */
  function wikimedia(options: {
    readonly original?: string | null;
    readonly licence?: string | null;
    readonly artist?: string | null;
    readonly licenceUrl?: string | null;
    readonly description?: string | null;
  }) {
    const extmetadata: Record<string, { value: string }> = {};
    if (options.licence) extmetadata.LicenseShortName = { value: options.licence };
    if (options.artist) extmetadata.Artist = { value: options.artist };
    if (options.licenceUrl) extmetadata.LicenseUrl = { value: options.licenceUrl };
    if (options.description) extmetadata.ImageDescription = { value: options.description };

    return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("prop=pageimages")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              query: {
                pages: [
                  options.original === null
                    ? {}
                    : {
                        original: {
                          source:
                            options.original ??
                            "https://upload.wikimedia.org/wikipedia/commons/f/f7/Berlin_Skyline.jpg",
                        },
                      },
                ],
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            query: {
              pages: [
                {
                  imageinfo: [
                    {
                      thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/x/1600px-Berlin.jpg",
                      thumbwidth: 1600,
                      thumbheight: 900,
                      extmetadata,
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    });
  }

  it("shows a freely licensed photograph with no credential configured at all", async () => {
    wikimedia({ licence: "CC BY-SA 4.0", artist: "<a href='#'>A Photographer</a>" });
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();

    const image = await resolveLocationImage("Berlin, Germany");
    expect(image.source).toBe("commons");
    expect(image.url).toContain("1600px-Berlin.jpg");
  });

  it("credits the author of the derived file rather than the whole provenance chain", async () => {
    /*
     * Commons' `Artist` for a derived file is its history: "File:Museumsinsel Berlin Juli 2021 1
     * (cropped).jpg : Kasa Fue derivative work: Georgfotoart" is what Berlin's lead image actually
     * returns. A credit line is a person, so it reduces to the one the chain ends on.
     */
    wikimedia({
      licence: "CC BY-SA 4.0",
      artist:
        "<a href='#'>File:Museumsinsel Berlin Juli 2021 1 (cropped).jpg</a>: Kasa Fue derivative work: <a href='#'>Georgfotoart</a>",
    });
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();
    expect((await resolveLocationImage("Berlin, Germany")).credit?.name).toBe("Georgfotoart");
  });

  it("carries the photographer and the licence the file's own metadata names", async () => {
    wikimedia({
      licence: "CC BY-SA 4.0",
      licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      artist: "<ul><li><a href='#'>A Photographer</a></li></ul>",
    });
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();

    const image = await resolveLocationImage("Berlin, Germany");
    // The markup Wikimedia wraps the artist in is not what a credit line should read.
    expect(image.credit?.name).toBe("A Photographer");
    expect(image.credit?.licence).toBe("CC BY-SA 4.0");
    expect(image.credit?.licenceUrl).toBe("https://creativecommons.org/licenses/by-sa/4.0");
  });

  it("refuses a file whose metadata names no licence, rather than showing it uncredited", async () => {
    wikimedia({ licence: null, artist: "Someone" });
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();
    expect((await resolveLocationImage("Berlin, Germany")).source).toBe("generated");
  });

  it("refuses a non-free file", async () => {
    wikimedia({ licence: "Fair use", artist: "Someone" });
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();
    expect((await resolveLocationImage("Berlin, Germany")).source).toBe("generated");
  });

  it("credits nobody rather than crediting Wikimedia, when the file names no artist", async () => {
    wikimedia({ licence: "CC0", artist: null });
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();
    const image = await resolveLocationImage("Berlin, Germany");
    expect(image.source).toBe("commons");
    expect(image.credit).toBeUndefined();
  });

  it("skips a lead image this frame cannot show", async () => {
    wikimedia({
      original: "https://upload.wikimedia.org/wikipedia/commons/a/b/Coat_of_arms.svg",
      licence: "CC BY-SA 4.0",
    });
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();
    expect((await resolveLocationImage("Berlin, Germany")).source).toBe("generated");
  });

  it("falls through to artwork when the place has no article", async () => {
    wikimedia({ original: null });
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();
    expect((await resolveLocationImage("Nowhere-at-all")).source).toBe("generated");
  });

  it("is skipped entirely when a deployment switches it off", async () => {
    process.env.CITY_IMAGE_COMMONS = "off";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { resolveLocationImage, resetLocationImageCache } = await load();
    resetLocationImageCache();

    expect((await resolveLocationImage("Berlin, Germany")).source).toBe("generated");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the module boundary", () => {
  it("refuses to load in a browser, so a client import fails loudly rather than leaking", async () => {
    vi.resetModules();
    // Stand a `window` up for the duration, which is what a client bundle would give it.
    vi.stubGlobal("window", {} as unknown as Window & typeof globalThis);
    await expect(import("./provider.server")).rejects.toThrow(/server-only/i);
    vi.unstubAllGlobals();
  });

  it("is the only place in the frontend that reads a provider key", async () => {
    const { execSync } = await import("node:child_process");
    // Anything outside the server module and its own test would be a leak waiting to happen.
    const hits = execSync(
      "grep -rl -E 'PEXELS_API_KEY|UNSPLASH_ACCESS_KEY' --include='*.ts' --include='*.tsx' . " +
        "| grep -v node_modules || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.replace(/^\.\//, ""));

    /*
     * Three files, and the third names them in order to *forbid* them.
     *
     * `scripts/secret-containment.ts` lists both keys in `SECRET_NAMES`, which is what makes
     * either one a containment failure rather than the warning an unfamiliar name would otherwise
     * get — whether it is written into a `frontend/.env*` file or given a public build prefix. A
     * policy file has to name the thing it prohibits, so its presence here is the rule working.
     *
     * (This comment deliberately does not spell that prefix and a key name out together: the
     * source scan matches the literal string wherever it appears, comments included, and it was
     * right to flag an earlier draft of this very paragraph.)
     *
     * This stays an exact list rather than becoming a prefix match: the point of the assertion is
     * that a *fourth* file cannot start reading a provider key without someone noticing.
     */
    expect(hits.sort()).toEqual(
      [
        "lib/images/provider.server.ts",
        "lib/images/provider.test.ts",
        "scripts/secret-containment.ts",
      ].sort(),
    );
  });

  it("keeps the keys out of NEXT_PUBLIC_", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/images/provider.server.ts", "utf8");
    expect(source).not.toMatch(/NEXT_PUBLIC_(PEXELS|UNSPLASH|CITY_IMAGE)/);
    expect(locationKey("Berlin, Germany")).toBe("berlin");
  });
});
