import {
  assignEventsToPlaces,
  buildBestTimeSignal,
  buildTelemetrySignal,
  buildTemporalSignal,
  calculateEstimate,
  type CrowdCacheInput,
  type EventInput,
  type PlaceInput,
  type PresenceProfileInput,
  type PresenceSnapshotInput,
} from "../supabase/functions/_shared/crowd-engine.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const nightlifePlace: PlaceInput = {
  id: 1,
  fsq_place_id: "test-place",
  category: "nightlife",
  latitude: 45.4523,
  longitude: 9.1777,
};

Deno.test("temporal fallback uses Europe/Rome category and weekend profile", () => {
  const signal = buildTemporalSignal(nightlifePlace, new Date("2026-09-19T23:00:00.000Z"));
  assert(signal.kind === "temporal", "expected temporal signal");
  assert(signal.score === 88, `expected weekend late-night score 88, received ${signal.score}`);
  assert(signal.confidence === 0.3, "fallback confidence must stay low");
});

Deno.test("BestTime value 999 and unavailable scores are ignored", () => {
  const invalid: CrowdCacheInput = {
    besttime_venue_id: "venue",
    crowd_score: 999,
    confidence: "high",
    fetched_at: "2026-09-20T18:00:00.000Z",
    expires_at: "2026-09-20T18:30:00.000Z",
  };
  assert(
    buildBestTimeSignal(1, invalid, new Date("2026-09-20T18:10:00.000Z")) === null,
    "999 must not become a crowd signal",
  );
});

Deno.test("stale BestTime is down-weighted and data older than 24h is ignored", () => {
  const cache: CrowdCacheInput = {
    besttime_venue_id: "venue",
    crowd_score: 70,
    confidence: "high",
    fetched_at: "2026-09-20T12:00:00.000Z",
    expires_at: "2026-09-20T12:30:00.000Z",
  };
  const stale = buildBestTimeSignal(1, cache, new Date("2026-09-20T18:00:00.000Z"));
  assert(stale !== null, "six-hour-old provider data should remain a cautious stale signal");
  assert(stale.weight < 0.55, "stale signal weight must decay");
  assert(stale.confidence <= 0.5, "stale confidence must be capped");
  assert(
    buildBestTimeSignal(1, cache, new Date("2026-09-21T13:00:00.000Z")) === null,
    "provider data older than 24h must be ignored",
  );
});

Deno.test("direct active event adds a controlled boost and produces an upward trend", () => {
  const now = new Date("2026-09-20T20:00:00.000Z");
  const event: EventInput = {
    id: 10,
    place_id: 1,
    category: "nightlife",
    latitude: nightlifePlace.latitude,
    longitude: nightlifePlace.longitude,
    start_at: "2026-09-20T19:00:00.000Z",
    end_at: "2026-09-20T23:00:00.000Z",
    is_active: true,
  };
  const eventSignal = assignEventsToPlaces([nightlifePlace], [event], now).get(1)?.[0];
  assert(eventSignal?.score === 18, "active event boost should be controlled at 18 points");
  const temporal = buildTemporalSignal(nightlifePlace, now);
  const estimate = calculateEstimate(1, [temporal, eventSignal], temporal.score, now);
  assert(estimate.score === Math.min(100, temporal.score + 18), "event should add to the baseline");
  assert(estimate.score < 100, "a single event must not force the score to 100");
  assert(estimate.trend === "up", "an 18-point change must produce an upward trend");
  assert(estimate.metadata.isFallback === true, "event plus temporal data remains an estimate");
});

Deno.test("unlinked events only attach to a close same-category place", () => {
  const now = new Date("2026-09-20T20:00:00.000Z");
  const nearby: EventInput = {
    id: 11,
    place_id: null,
    category: "nightlife",
    latitude: 45.45231,
    longitude: 9.17771,
    start_at: "2026-09-20T20:00:00.000Z",
    end_at: "2026-09-20T22:00:00.000Z",
    is_active: true,
  };
  const signal = assignEventsToPlaces([nightlifePlace], [nearby], now).get(1)?.[0];
  assert(signal?.metadata.match === "geo", "expected cautious geographic association");
  assert(signal.score === 10, "geo match should reduce the event boost");
  assert(signal.confidence === 0.45, "geo match confidence must remain low");
});

Deno.test("an exact-location event can attach across catalogue categories", () => {
  const outdoorPlace: PlaceInput = { ...nightlifePlace, category: "outdoor" };
  const event: EventInput = {
    id: 12,
    place_id: null,
    category: "nightlife",
    latitude: outdoorPlace.latitude,
    longitude: outdoorPlace.longitude,
    start_at: "2026-09-20T20:00:00.000Z",
    end_at: "2026-09-20T22:00:00.000Z",
    is_active: true,
  };
  const signal = assignEventsToPlaces(
    [outdoorPlace],
    [event],
    new Date("2026-09-20T20:00:00.000Z"),
  ).get(1)?.[0];
  assert(signal?.metadata.match === "geo", "exact coordinates should permit a cautious match");
});

Deno.test("telemetry requires at least five anonymous sessions", () => {
  const now = new Date("2026-09-20T20:20:00.000Z");
  const snapshot: PresenceSnapshotInput = {
    place_id: 1,
    window_start: "2026-09-20T20:00:00.000Z",
    window_end: "2026-09-20T20:20:00.000Z",
    confirmed_sessions: 4,
    weighted_presence: 4,
    average_presence_confidence: 0.9,
    telemetry_observations: 12,
    telemetry_sessions: 4,
    telemetry_coverage: 0.8,
  };
  assert(buildTelemetrySignal(1, snapshot, null, now) === null, "small groups must stay private");
});

Deno.test("fresh aggregated telemetry becomes a live high-weight signal", () => {
  const now = new Date("2026-09-20T20:20:00.000Z");
  const snapshot: PresenceSnapshotInput = {
    place_id: 1,
    window_start: "2026-09-20T20:00:00.000Z",
    window_end: "2026-09-20T20:20:00.000Z",
    confirmed_sessions: 14,
    weighted_presence: 12,
    average_presence_confidence: 0.9,
    telemetry_observations: 48,
    telemetry_sessions: 14,
    telemetry_coverage: 0.85,
  };
  const profile: PresenceProfileInput = {
    place_id: 1,
    p25_weighted_presence: 4,
    p50_weighted_presence: 8,
    p75_weighted_presence: 12,
    p90_weighted_presence: 16,
    max_weighted_presence: 22,
    sample_count: 60,
    distinct_days: 8,
    confidence: 0.8,
  };
  const signal = buildTelemetrySignal(1, snapshot, profile, now);
  assert(signal?.kind === "telemetry", "expected telemetry signal");
  assert(signal.score === 70, `expected p75 score 70, received ${signal.score}`);
  assert(signal.weight > 0.9, "fresh telemetry should outweigh a temporal baseline");
  const estimate = calculateEstimate(1, [buildTemporalSignal(nightlifePlace, now), signal], null, now);
  assert(estimate.metadata.isFallback === false, "qualified telemetry must be presented as live data");
});
