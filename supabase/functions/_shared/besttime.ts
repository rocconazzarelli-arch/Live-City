export const BESTTIME_NEW_FORECAST_URL =
  "https://besttime.app/api/v1/forecasts";
export const BESTTIME_LIVE_URL = "https://besttime.app/api/v1/forecasts/live";
export const BESTTIME_KEYS_URL = "https://besttime.app/api/v1/keys";

export type BestTimeLiveClassification =
  | { kind: "live"; score: number }
  | { kind: "unavailable" }
  | {
    kind: "failed";
    reason: "provider_payload_invalid" | "provider_status_not_ok";
  };

/**
 * BestTime Live can legitimately exceed 100 when a venue is busier than its
 * forecasted weekly peak. LIVE CITY stores a bounded 0-100 score, so values
 * above 100 are saturated instead of being mistaken for missing data.
 */
export function normalizeBestTimeLiveScore(value: unknown): number | null {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    value === 999
  ) {
    return null;
  }
  return Math.min(100, Math.round(value));
}

/**
 * Separates a venue-specific "no live data" result from provider-wide errors.
 * Only the former is allowed to suspend future paid reads for that venue.
 */
export function classifyBestTimeLivePayload(
  payload: unknown,
): BestTimeLiveClassification {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "failed", reason: "provider_payload_invalid" };
  }
  const response = payload as {
    status?: unknown;
    message?: unknown;
    error?: unknown;
    analysis?: {
      venue_live_busyness?: unknown;
      venue_live_busyness_available?: unknown;
    };
  };
  if (response.status !== "OK") {
    const providerMessage = [response.message, response.error]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    if (
      providerMessage.includes("live") &&
      (providerMessage.includes("not available") ||
        providerMessage.includes("no live data"))
    ) {
      return { kind: "unavailable" };
    }
    return { kind: "failed", reason: "provider_status_not_ok" };
  }
  const score = normalizeBestTimeLiveScore(
    response.analysis?.venue_live_busyness,
  );
  if (
    response.analysis?.venue_live_busyness_available !== true || score === null
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "live", score };
}
