import {
  calculateEstimate,
  type EngineSignal,
  type PlaceInput,
} from "../supabase/functions/_shared/crowd-engine.ts";
import { buildHistoryRows, historyBucketStart } from "../supabase/functions/_shared/crowd-history.ts";
import {
  buildArchiveUrl,
  buildForecastUrl,
  MILAN_WEATHER_LOCATION,
  parseHourlyWeather,
  validateBackfillRange,
} from "../supabase/functions/_shared/weather.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const park: PlaceInput = {
  id: 7,
  fsq_place_id: "parco-sempione",
  category: "outdoor",
  latitude: 45.4723,
  longitude: 9.1795,
};

const hour = (iso: string) => Date.parse(iso) / 1000;

Deno.test("forecast hours are split into analysis and forecast around now", () => {
  const now = new Date("2026-10-23T12:30:00.000Z");
  const rows = parseHourlyWeather({
    hourly: {
      time: [hour("2026-10-23T11:00:00Z"), hour("2026-10-23T12:00:00Z"), hour("2026-10-23T13:00:00Z")],
      temperature_2m: [18.2, 19, 19.4],
      precipitation: [0, 0, 0.4],
      cloud_cover: [10, 20, 80],
      is_day: [1, 1, 1],
      sunshine_duration: [3600, 3000, 0],
    },
  }, MILAN_WEATHER_LOCATION, "forecast", now);

  assert(rows.length === 3, `expected 3 rows, received ${rows.length}`);
  assert(rows[0].data_kind === "analysis", "an elapsed hour must be analysis");
  assert(rows[1].data_kind === "forecast", "the running hour is still a forecast");
  assert(rows[2].data_kind === "forecast", "a future hour must be forecast");
  assert(rows[0].observed_at === "2026-10-23T11:00:00.000Z", "hour start must be UTC ISO");
  assert(rows[0].is_day === true, "is_day must become a boolean");
  assert(rows[2].rain_mm === null, "a missing variable must become null");
});

Deno.test("archive rows are reanalysis and empty lagging hours are dropped", () => {
  const rows = parseHourlyWeather({
    hourly: {
      time: [hour("2026-10-01T10:00:00Z"), hour("2026-10-01T11:00:00Z")],
      temperature_2m: [21.5, null],
      precipitation: [0, null],
      cloud_cover: [5, null],
    },
  }, MILAN_WEATHER_LOCATION, "archive", new Date("2026-10-23T12:00:00.000Z"));

  assert(rows.length === 1, `expected the empty hour to be dropped, received ${rows.length}`);
  assert(rows[0].data_kind === "reanalysis", "archive data must be reanalysis");
});

Deno.test("Open-Meteo URLs request UTC unix hours and switch host with an API key", () => {
  const free = new URL(buildForecastUrl(MILAN_WEATHER_LOCATION));
  assert(free.host === "api.open-meteo.com", "free forecast host expected");
  assert(free.searchParams.get("timeformat") === "unixtime", "unixtime expected");
  assert(free.searchParams.get("timezone") === "GMT", "GMT expected");
  assert(!free.searchParams.has("apikey"), "free calls must not send a key");

  const paid = new URL(buildArchiveUrl(MILAN_WEATHER_LOCATION, "2025-01-01", "2025-01-31", "key"));
  assert(paid.host === "customer-archive-api.open-meteo.com", "customer archive host expected");
  assert(paid.searchParams.get("apikey") === "key", "API key must be forwarded");
});

Deno.test("backfill ranges are validated", () => {
  const now = new Date("2026-10-23T12:00:00.000Z");
  assert(validateBackfillRange("2025-10-23", "2026-10-22", now).ok, "a one-year range is allowed");
  assert(!validateBackfillRange("2024-01-01", "2026-01-01", now).ok, "over 366 days is rejected");
  assert(!validateBackfillRange("2026-10-22", "2026-10-01", now).ok, "inverted range is rejected");
  assert(!validateBackfillRange("2026-10-01", "2026-11-01", now).ok, "future end is rejected");
  assert(!validateBackfillRange("01/10/2026", "2026-10-02", now).ok, "non-ISO dates are rejected");
});

Deno.test("history buckets align to 20 minutes", () => {
  assert(
    historyBucketStart(new Date("2026-10-23T12:39:59.000Z")) === "2026-10-23T12:20:00.000Z",
    "expected the 12:20 bucket",
  );
});

Deno.test("history rows flatten engine signals per place", () => {
  const now = new Date("2026-10-25T13:00:00.000Z");
  const bestTime: EngineSignal = {
    placeId: park.id,
    source: "besttime",
    signalType: "observed",
    kind: "besttime",
    score: 72,
    weight: 1,
    confidence: 0.9,
    observedAt: "2026-10-25T12:55:00.000Z",
    validUntil: "2026-10-25T13:25:00.000Z",
    metadata: { stale: false },
  };
  const telemetry: EngineSignal = {
    placeId: park.id,
    source: "live_city",
    signalType: "observed",
    kind: "telemetry",
    score: 80,
    weight: 1,
    confidence: 0.7,
    observedAt: "2026-10-25T12:50:00.000Z",
    validUntil: "2026-10-25T13:30:00.000Z",
    metadata: { confirmedSessions: 9 },
  };
  const signals = [bestTime, telemetry];
  const estimate = calculateEstimate(park.id, signals, null, now);
  const [row] = buildHistoryRows([estimate], signals, historyBucketStart(now));

  assert(row.place_id === park.id, "place id expected");
  assert(row.score === estimate.score, "score must match the estimate");
  assert(row.is_fallback === false, "a live signal is not a fallback");
  assert(row.historical_score === null, "no historical prediction when live data exists");
  assert(row.besttime_score === 72 && row.besttime_stale === false, "BestTime reading expected");
  assert(row.besttime_observed_at === bestTime.observedAt, "BestTime observation time expected");
  assert(row.telemetry_score === 80 && row.telemetry_sessions === 9, "telemetry aggregate expected");
  assert(row.formula_version === estimate.metadata.formulaVersion, "formula version expected");
});

Deno.test("historical-only rows are fallbacks with empty live columns", () => {
  const now = new Date("2026-10-23T02:00:00.000Z");
  const historical: EngineSignal = {
    placeId: park.id,
    source: "live_city",
    signalType: "forecast",
    kind: "historical",
    score: 41,
    weight: 0.7,
    confidence: 0.5,
    observedAt: now.toISOString(),
    validUntil: "2026-10-23T03:00:00.000Z",
    metadata: {},
  };
  const estimate = calculateEstimate(park.id, [historical], null, now);
  const [row] = buildHistoryRows([estimate], [historical], historyBucketStart(now));

  assert(row.is_fallback === true, "a historical-only estimate is a fallback");
  assert(row.historical_score === 41, "historical score expected");
  assert(row.besttime_score === null && row.besttime_stale === null, "no BestTime columns expected");
  assert(row.telemetry_sessions === null, "no telemetry columns expected");
  assert(row.event_count === 0 && row.event_boost === 0, "no event contribution expected");
});

Deno.test("unavailable places are not recorded as zero crowd", () => {
  const now = new Date("2026-10-23T02:00:00.000Z");
  const estimate = calculateEstimate(park.id, [], null, now);
  const rows = buildHistoryRows([estimate], [], historyBucketStart(now));

  assert(estimate.metadata.isUnavailable === true, "precondition: no signals means unavailable");
  assert(rows.length === 0, `expected no history row, received ${rows.length}`);
});
