/**
 * The cache keys for the person's own data — task 21.6.
 *
 * Until Settings existed, nothing in the frontend *wrote* a preference or a saved location, so each
 * screen could key its own read however it liked and no two could disagree. A write changes that:
 * `specs/web-ui` requires that setting imperial units in Settings makes later screens render in
 * imperial, and a screen holding the same answer under a private key would keep serving the old one
 * out of cache for the rest of its stale window.
 *
 * So the reads that a write invalidates share one key each, named here. That is the whole reason
 * this file exists: an invalidation can only reach a key it can name.
 *
 * Screen-local keys — a forecast for a chosen place, a comparison of three cities — deliberately
 * stay in their screens. They are not shared state and nothing writes them.
 */

/** The acting user's effective preferences, read by the Dashboard, Historical, Compare and Settings. */
export const PREFERENCES_KEY = ["me", "preferences"] as const;

/** The acting user's saved locations, read by Saved Locations, Historical and Compare. */
export const SAVED_LOCATIONS_KEY = ["me", "locations"] as const;

/** The acting user's conversation threads, read by Settings. */
export const THREADS_KEY = ["me", "threads"] as const;
