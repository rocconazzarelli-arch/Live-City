import type { EngineSignal, EstimateResult } from "./crowd-engine.ts";

// Training history for the predictive model: one row per place per 20-minute
// refresh bucket, flattening every signal the engine used. Only aggregates are
// stored; telemetry appears only after it passed the privacy threshold.
// Unlike crowd_signals, this table is not purged after 24 hours.

export const HISTORY_BUCKET_MS = 20 * 60 * 1000;

export type CrowdHistoryRow = {
  place_id: number;
  bucket_start: string;
  calculated_at: string;
  score: number;
  activity_level: string;
  confidence: number;
  dominant_source: string;
  is_fallback: boolean;
  historical_score: number | null;
  besttime_score: number | null;
  besttime_observed_at: string | null;
  besttime_stale: boolean | null;
  telemetry_score: number | null;
  telemetry_sessions: number | null;
  mastercard_score: number | null;
  mastercard_transactions: number | null;
  event_boost: number;
  event_count: number;
  signal_count: number;
  formula_version: string;
};

export function historyBucketStart(now: Date): string {
  return new Date(Math.floor(now.getTime() / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS).toISOString();
}

export function buildHistoryRows(
  estimates: EstimateResult[],
  signals: EngineSignal[],
  bucketStart: string,
): CrowdHistoryRow[] {
  const signalsByPlace = new Map<number, EngineSignal[]>();
  for (const signal of signals) {
    signalsByPlace.set(signal.placeId, [...(signalsByPlace.get(signal.placeId) ?? []), signal]);
  }

  return estimates
    // An unavailable place has a placeholder score of 0; recording it would
    // teach the model a crowd level that was never observed.
    .filter((estimate) => estimate.metadata.isUnavailable !== true)
    .map((estimate) => {
      const placeSignals = signalsByPlace.get(estimate.placeId) ?? [];
      const historical = placeSignals.find((signal) => signal.kind === "historical");
      const bestTime = placeSignals.find((signal) => signal.kind === "besttime");
      const telemetry = placeSignals.find((signal) => signal.kind === "telemetry");
      const mastercard = placeSignals.find((signal) => signal.kind === "mastercard");
      const sessions = telemetry?.metadata.confirmedSessions;
      const transactions = mastercard?.metadata.transactionCount;

      return {
        place_id: estimate.placeId,
        bucket_start: bucketStart,
        calculated_at: estimate.calculatedAt,
        score: estimate.score,
        activity_level: estimate.activityLevel,
        confidence: estimate.confidence,
        dominant_source: estimate.dominantSource,
        is_fallback: estimate.metadata.isFallback === true,
        historical_score: historical?.score ?? null,
        besttime_score: bestTime?.score ?? null,
        // Repeated refreshes reuse one BestTime fetch; observed_at lets the
        // model deduplicate provider readings.
        besttime_observed_at: bestTime?.observedAt ?? null,
        besttime_stale: bestTime ? bestTime.metadata.stale === true : null,
        telemetry_score: telemetry?.score ?? null,
        telemetry_sessions: typeof sessions === "number" ? sessions : null,
        mastercard_score: mastercard?.score ?? null,
        mastercard_transactions: typeof transactions === "number" ? transactions : null,
        event_boost: Number(estimate.metadata.eventBoost ?? 0),
        event_count: placeSignals.filter((signal) => signal.kind === "event").length,
        signal_count: estimate.signalCount,
        formula_version: String(estimate.metadata.formulaVersion ?? "unknown"),
      };
    });
}
