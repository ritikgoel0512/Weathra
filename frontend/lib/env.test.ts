import { afterEach, describe, expect, it } from "vitest";

import { publicEnv } from "./env";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

describe("publicEnv", () => {
  it("reads the public Supabase and backend configuration", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:8000";

    expect(publicEnv.supabaseUrl).toBe("https://project.supabase.co");
    expect(publicEnv.supabaseAnonKey).toBe("anon-key");
    expect(publicEnv.apiBaseUrl).toBe("http://localhost:8000");
  });

  it("names the missing variable rather than failing obscurely", () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    expect(() => publicEnv.apiBaseUrl).toThrow(/NEXT_PUBLIC_API_BASE_URL is not set/);
  });
});
