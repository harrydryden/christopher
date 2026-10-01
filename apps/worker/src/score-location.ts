import type { ScoreJobInput } from "@ava/ai";

type LocationInput = Pick<ScoreJobInput["job"], "location" | "locations" | "locationStatus">;

/** The places A5 may treat as current evidence, independent of a feed's list order. */
export function scoreLocationInput(job: {
  location: string | null;
  locations: string[];
  locationResolution: "pending" | "resolved" | "unavailable" | null;
}): LocationInput {
  // A Workday refresh can retain its last verified names while the new detail is pending. Those
  // names keep an existing gate view, but are not evidence of where the current role is offered.
  if (job.locationResolution === "pending" || job.locationResolution === "unavailable")
    return { locationStatus: job.locationResolution };

  const names = new Map<string, string>();
  for (const raw of [job.location, ...job.locations]) {
    const name = raw?.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const prior = names.get(key);
    if (!prior || name < prior) names.set(key, name);
  }
  const places = [...names.values()].sort((a, b) => {
    const left = a.toLocaleLowerCase();
    const right = b.toLocaleLowerCase();
    return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  if (places.length > 1) return { locations: places };
  return places[0] ? { location: places[0] } : {};
}
