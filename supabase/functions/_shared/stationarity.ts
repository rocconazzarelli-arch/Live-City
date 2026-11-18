/**
 * Stationarity index of a heatmap cell: the share of sessions standing still.
 *
 * `refresh_crowd_area_snapshots()` counts, per cell and 20-minute window, the
 * sessions that stayed (same cell for 15 minutes or more) and the ones that
 * moved (seen in more than one cell during the window). Sessions it cannot
 * tell apart yet, such as a single observation, are in neither count.
 */

/** Sessions that must be classified before a share is published. */
export const STATIONARITY_MIN_CLASSIFIED_SESSIONS = 5;
/** Published shares are rounded to this step, so exact counts cannot be read back. */
export const STATIONARITY_SHARE_STEP = 0.05;

/**
 * Share of stationary sessions that is safe to return to clients, or null.
 * Below the privacy threshold nothing is published: with two classified
 * sessions a share would describe what individual people did.
 */
export function publishableStationaryShare(
  stationarySessions: number | null | undefined,
  movingSessions: number | null | undefined,
): number | null {
  if (!isCount(stationarySessions) || !isCount(movingSessions)) return null;
  const classified = stationarySessions + movingSessions;
  if (classified < STATIONARITY_MIN_CLASSIFIED_SESSIONS) return null;
  const steps = Math.round(stationarySessions / classified / STATIONARITY_SHARE_STEP);
  return Math.round(steps * STATIONARITY_SHARE_STEP * 100) / 100;
}

function isCount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
