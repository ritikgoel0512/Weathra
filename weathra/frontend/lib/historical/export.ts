/**
 * The archive window a person is looking at, as a file they can keep.
 *
 * `03-historical-analytics.png` carries an EXPORT DATA control in its header and this build had
 * none — finding 3.6 of the runtime fidelity audit of 2026-09-08.
 *
 * **It exports what is on the screen, and nothing else.** The rows are the entries the backend
 * returned for the selected window, in the order it returned them, with the values it reported.
 * Nothing is computed here, nothing is converted, and no absent value is filled: a measure the
 * provider did not report for a day is an empty cell, never a zero. That is the same rule every
 * surface in Weathra follows, and a spreadsheet is exactly where a zero standing in for "not
 * reported" would do the most damage.
 *
 * **The units are the response's own**, named in each column heading, so a file opened a month
 * later still says what it is in.
 *
 * The header block above the table records where the figures came from — the provider, the place,
 * the period and the unit system — because a CSV that has left the application is the one artifact
 * with no attribution footer beside it.
 */

import type { HistoryResponse } from "@/lib/api/schema";

/** RFC 4180: a field containing a comma, a quote or a newline is quoted, and quotes are doubled. */
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function row(values: readonly string[]): string {
  return values.map(field).join(",");
}

/** The measures the window reported, in the order they first appear. */
export function measuresIn(history: HistoryResponse): string[] {
  const seen: string[] = [];
  for (const entry of history.daily?.entries ?? []) {
    for (const key of Object.keys(entry.values ?? {})) {
      if (!seen.includes(key)) seen.push(key);
    }
  }
  return seen;
}

export function csvFromHistory(history: HistoryResponse): string {
  const measures = measuresIn(history);
  const units = history.daily?.units ?? {};
  // The period the response actually covers, which is the period the rows are for — shorter than
  // the request when the range runs into the archive's reporting lag.
  const period = history.covered_period;

  const preamble: string[] = [
    row(["# Weathra — historical observations, as retrieved"]),
    row([`# Provider: ${history.provider ?? "not reported"}`]),
    row([`# Location: ${history.location?.display_name ?? "not reported"}`]),
    row([
      `# Period: ${period?.start_local ?? "not reported"} to ${period?.end_local ?? "not reported"}`,
    ]),
    row([`# Units: ${history.units ?? "not reported"}`]),
    row([
      "# An empty cell is a measure the provider did not report for that day. It is not a zero.",
    ]),
  ];

  const heading = row([
    "date_local",
    ...measures.map((measure) => {
      const unit = units[measure];
      return unit ? `${measure} (${unit})` : measure;
    }),
  ]);

  const body = (history.daily?.entries ?? []).map((entry) =>
    row([
      entry.time_local ?? "",
      ...measures.map((measure) => {
        const value = entry.values?.[measure];
        return typeof value === "number" ? String(value) : "";
      }),
    ]),
  );

  return [...preamble, heading, ...body].join("\r\n");
}

/** The file's name: the place and the window, so two exports never collide. */
export function csvFilenameFor(history: HistoryResponse): string {
  const place = (history.location?.display_name ?? "location")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const period = history.covered_period;
  const start = (period?.start_local ?? "").slice(0, 10);
  const end = (period?.end_local ?? "").slice(0, 10);
  return `weathra-${place || "location"}-${start}-to-${end}.csv`;
}
