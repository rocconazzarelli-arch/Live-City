import {
  assignEventsToPlaces,
  buildBestTimeSignal,
  buildHistoricalSignal,
  buildMobilitySignal,
  buildTelemetrySignal,
  calculateEstimate,
  calculateHybridEstimate,
  type CrowdCacheInput,
  type EventInput,
  type HistoricalSlotInput,
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

Deno.test("historical prediction uses only a sufficiently sampled real observation slot", () => {
  const now = new Date("2026-09-18T20:00:00.000Z"); // Friday 22:00 Europe/Rome
  const slot: HistoricalSlotInput = {
    place_id: 1,
    local_weekday: 5,
    local_hour: 22,
    average_score: 74.4,
    sample_count: 28,
    distinct_days: 6,
    besttime_samples: 20,
    telemetry_samples: 8,
  };
  const signal = buildHistoricalSignal(1, slot, now);
  assert(signal?.kind === "historical", "expected historical observation prediction");
  assert(signal?.score === 74, "prediction must preserve observed-history average");
  assert(signal !== null && signal.confidence > 0.5, "enough real history must increase confidence");
  assert(buildHistoricalSignal(1, { ...slot, sample_count: 11 }, now) === null, "thin history must not predict");
});

Deno.test("BestTime value 999 and unavailable scores are ignored", () => {
  const invalid: CrowdCacheInput = {
    besttime_venue_id: "venue",
    crowd_score: 999,
    confidence: "high",
    fetched_at: "2026-09-20T18:00:00.000Z",
    expires_at: "2026-09-20T18:30:00.000Z",
    observation_mode: "live",
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
    observation_mode: "live",
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

Deno.test("BestTime forecasts and unclassified cache rows are never treated as live", () => {
  const cache: CrowdCacheInput = {
    besttime_venue_id: "venue",
    crowd_score: 70,
    confidence: "high",
    fetched_at: "2026-09-20T18:00:00.000Z",
    expires_at: "2026-09-20T18:30:00.000Z",
    observation_mode: "forecast",
  };
  const now = new Date("2026-09-20T18:10:00.000Z");
  assert(buildBestTimeSignal(1, cache, now) === null, "forecast must not be passed off as live");
  assert(
    buildBestTimeSignal(1, { ...cache, observation_mode: "unknown" }, now) === null,
    "legacy cache without provenance must not be passed off as live",
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
  const history = buildHistoricalSignal(1, {
    place_id: 1, local_weekday: 7, local_hour: 22, average_score: 70,
    sample_count: 20, distinct_days: 4, besttime_samples: 20, telemetry_samples: 0,
  }, now);
  assert(history !== null, "expected sampled history for event scenario");
  const estimate = calculateEstimate(1, [history, eventSignal], history.score, now);
  assert(estimate.score === Math.min(100, history.score + 18), "event should add to an observed-history prediction");
  assert(estimate.score < 100, "a single event must not force the score to 100");
  assert(estimate.trend === "up", "an 18-point change must produce an upward trend");
  assert(estimate.metadata.isFallback === true, "historical prediction remains a labelled estimate");
});

Deno.test("a community event is a declared forecast, never verified foot traffic", () => {
  const now = new Date("2026-09-20T20:00:00.000Z");
  const event: EventInput = {
    id: "community-event",
    place_id: 1,
    category: "nightlife",
    latitude: nightlifePlace.latitude,
    longitude: nightlifePlace.longitude,
    start_at: "2026-09-20T19:00:00.000Z",
    end_at: "2026-09-20T23:00:00.000Z",
    expected_attendance: 100,
    source: "community",
    is_active: true,
  };
  const eventSignal = assignEventsToPlaces([nightlifePlace], [event], now).get(1)?.[0];
  assert(eventSignal?.signalType === "forecast", "community event must remain a forecast");
  assert(eventSignal?.metadata.expectedAttendance === 100, "attendance must be auditable");
  assert(eventSignal !== undefined && eventSignal.score <= 25, "event boost must remain capped");
  const estimate = calculateEstimate(1, [eventSignal], null, now);
  assert(estimate.metadata.isUnavailable === false, "event forecast must not be discarded as unavailable");
  assert(estimate.metadata.isFallback === true, "event-only estimate must be labelled as a forecast");
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
  assert(signal.weight > 0.9, "fresh telemetry should carry high weight");
  const estimate = calculateEstimate(1, [signal], null, now);
  assert(estimate.metadata.isFallback === false, "qualified telemetry must be presented as live data");
});

Deno.test("scheduled mobility is a forecast proxy and never verified live foot traffic", () => {
  const now = new Date("2026-10-15T08:00:00.000Z");
  const signal = buildMobilitySignal(1, {
    grid_key: "11367:2297",
    local_day_type: "L",
    local_hour: 10,
    service_intensity: 42.5,
    mobility_score: 68,
    stop_count: 7,
    source_updated_at: "2026-07-24T14:01:00.000Z",
    refreshed_at: "2026-10-15T03:41:00.000Z",
  }, now);
  assert(signal?.kind === "mobility", "expected a mobility signal");
  assert(signal?.signalType === "forecast", "mobility schedule must remain a forecast");
  assert(signal?.metadata.sourceMode === "scheduled_proxy", "mobility provenance must be explicit");
});

Deno.test("hybrid engine anchors on telemetry and labels proxy-only results as forecast", () => {
  const now = new Date("2026-10-15T08:00:00.000Z");
  const mobility = buildMobilitySignal(1, {
    grid_key: "11367:2297",
    local_day_type: "L",
    local_hour: 10,
    service_intensity: 42.5,
    mobility_score: 80,
    stop_count: 7,
    source_updated_at: "2026-07-24T14:01:00.000Z",
    refreshed_at: "2026-10-15T03:41:00.000Z",
  }, now);
  assert(mobility !== null, "expected mobility proxy");
  const forecastOnly = calculateHybridEstimate(1, [mobility], null, now);
  assert(forecastOnly.metadata.dataClass === "forecast", "proxy-only result must be forecast");
  assert(forecastOnly.metadata.isFallback === true, "proxy-only result must be labelled fallback");

  const telemetry = buildTelemetrySignal(1, {
    place_id: 1,
    window_start: "2026-10-15T07:40:00.000Z",
    window_end: "2026-10-15T08:00:00.000Z",
    confirmed_sessions: 10,
    weighted_presence: 8,
    average_presence_confidence: 0.85,
    telemetry_observations: 24,
    telemetry_sessions: 10,
    telemetry_coverage: 0.8,
  }, null, now);
  assert(telemetry !== null, "expected qualified telemetry");
  const hybrid = calculateHybridEstimate(1, [telemetry, mobility], null, now);
  assert(hybrid.metadata.dataClass === "verified_live", "telemetry must make the result live");
  assert(hybrid.dominantSource === "telemetry", "telemetry must remain the dominant source");
  assert(hybrid.score < mobility.score, "mobility cannot outweigh a lower live telemetry anchor");
});
