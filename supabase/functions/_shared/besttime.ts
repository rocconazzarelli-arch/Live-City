export const BESTTIME_NEW_FORECAST_URL = "https://besttime.app/api/v1/forecasts";
export const BESTTIME_LIVE_URL = "https://besttime.app/api/v1/forecasts/live";
export const BESTTIME_KEYS_URL = "https://besttime.app/api/v1/keys";

/**
 * BestTime Live can legitimately exceed 100 when a venue is busier than its
 * forecasted weekly peak. LIVE CITY stores a bounded 0-100 score, so values
 * above 100 are saturated instead of being mistaken for missing data.
 */
export function normalizeBestTimeLiveScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value === 999) {
    return null;
  }
  return Math.min(100, Math.round(value));
}
