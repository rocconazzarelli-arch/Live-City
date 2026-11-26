// Per-venue BestTime Live read windows.
//
// `venue_mappings.live_read_hours` lists the local Europe/Rome clock hours
// (0-23) in which a venue may be queried. A refresh that runs at 19:30 Rome
// time belongs to hour 19. Missing, null, malformed, and empty schedules all
// fail closed: the venue is never read. This prevents an incomplete mapping
// from consuming paid BestTime calls.
// Every live call costs a BestTime credit, even for a closed venue, so the
// window should match the hours in which the venue is actually open.

export const LIVE_SCHEDULE_TIME_ZONE = "Europe/Rome";

const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: LIVE_SCHEDULE_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

/** Local Europe/Rome clock hour (0-23) for an instant. */
export function romeHour(date: Date): number {
  const hourPart = hourFormatter.formatToParts(date).find((part) => part.type === "hour");
  const hour = Number(hourPart?.value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Unable to resolve ${LIVE_SCHEDULE_TIME_ZONE} hour`);
  }
  return hour;
}

/**
 * Sanitises a database value into a list of valid hours. Invalid entries are
 * dropped rather than widening the
 * window, so a malformed row can never cause extra (paid) live calls.
 */
export function normalizeLiveReadHours(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const hours = value
    .map((entry) => Number(entry))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
  return [...new Set(hours)].sort((a, b) => a - b);
}

/** Whether a venue with this schedule should be read in the given hour. */
export function isLiveReadDue(hours: readonly number[] | null, hour: number): boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Array.isArray(hours)) return false;
  return hours.includes(hour);
}
