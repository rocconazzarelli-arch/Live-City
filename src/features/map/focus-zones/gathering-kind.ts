/**
 * Gatherings versus pedestrian flows.
 *
 * A density map is a snapshot: a packed square and a packed shopping street
 * look the same. What tells them apart is whether people stay. The backend
 * publishes, for every k-anonymous cell, the share of sessions that stood
 * still (same cell for 15 minutes or more) among those it could classify;
 * this module turns that share into a kind of crowd.
 *
 * Splitting gatherings into "more than usual" (an event) and "as usual" needs
 * the expected-crowd model, which does not exist yet: until then a gathering
 * is only "people staying".
 */
export type GatheringKind =
  /** Most people are staying: a square, a park, a venue. */
  | 'gathering'
  /** Staying and walking in similar amounts. */
  | 'mixed'
  /** Most people are walking through: not a place to go to. */
  | 'flow'
  /** No stationarity signal for this zone. */
  | 'unknown';

/**
 * Thresholds on the share of stationary sessions. First guesses: calibrate
 * them on real telemetry before trusting the labels.
 */
export const GATHERING_MIN_STATIONARY_SHARE = 0.6;
export const FLOW_MAX_STATIONARY_SHARE = 0.35;

export function classifyGathering(stationaryShare: number | null | undefined): GatheringKind {
  if (stationaryShare === null || stationaryShare === undefined || !Number.isFinite(stationaryShare)) {
    return 'unknown';
  }
  if (stationaryShare >= GATHERING_MIN_STATIONARY_SHARE) return 'gathering';
  if (stationaryShare <= FLOW_MAX_STATIONARY_SHARE) return 'flow';
  return 'mixed';
}

/** Short Italian label for the map; null when there is nothing to say. */
export function gatheringKindLabel(kind: GatheringKind): string | null {
  switch (kind) {
    case 'gathering':
      return 'Gente ferma';
    case 'mixed':
      return 'Fermi e di passaggio';
    case 'flow':
      return 'Di passaggio';
    default:
      return null;
  }
}
