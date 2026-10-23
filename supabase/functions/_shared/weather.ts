// Hourly Milan weather from Open-Meteo. Pure helpers only: the Edge Function
// owns network and database access so this module stays testable.

export type WeatherDataKind = "forecast" | "analysis" | "reanalysis";

export type WeatherLocation = {
  key: string;
  latitude: number;
  longitude: number;
};

export type WeatherRow = {
  location_key: string;
  observed_at: string;
  latitude: number;
  longitude: number;
  temperature_c: number | null;
  apparent_temperature_c: number | null;
  relative_humidity_pct: number | null;
  precipitation_mm: number | null;
  rain_mm: number | null;
  cloud_cover_pct: number | null;
  wind_speed_kmh: number | null;
  weather_code: number | null;
  is_day: boolean | null;
  sunshine_duration_s: number | null;
  data_kind: WeatherDataKind;
  provider: "open-meteo";
};

type OpenMeteoHourly = {
  time?: number[];
  temperature_2m?: (number | null)[];
  apparent_temperature?: (number | null)[];
  relative_humidity_2m?: (number | null)[];
  precipitation?: (number | null)[];
  rain?: (number | null)[];
  cloud_cover?: (number | null)[];
  wind_speed_10m?: (number | null)[];
  weather_code?: (number | null)[];
  is_day?: (number | null)[];
  sunshine_duration?: (number | null)[];
};

export type OpenMeteoResponse = {
  hourly?: OpenMeteoHourly;
};

// One representative point for V1 (Duomo). Milan is small enough that a single
// grid cell captures the weather contrasts that matter for crowd formation.
export const MILAN_WEATHER_LOCATION: WeatherLocation = {
  key: "milano",
  latitude: 45.4642,
  longitude: 9.19,
};

export const HOURLY_VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation",
  "rain",
  "cloud_cover",
  "wind_speed_10m",
  "weather_code",
  "is_day",
  "sunshine_duration",
] as const;

export const MAX_BACKFILL_DAYS = 366;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function buildForecastUrl(location: WeatherLocation, apiKey?: string): string {
  const host = apiKey ? "https://customer-api.open-meteo.com" : "https://api.open-meteo.com";
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    hourly: HOURLY_VARIABLES.join(","),
    // Recent past hours are rewritten as the model re-analyses them; the
    // next days give the predictive model its weather inputs.
    past_days: "2",
    forecast_days: "3",
    timezone: "GMT",
    timeformat: "unixtime",
  });
  if (apiKey) params.set("apikey", apiKey);
  return `${host}/v1/forecast?${params}`;
}

export function buildArchiveUrl(
  location: WeatherLocation,
  startDate: string,
  endDate: string,
  apiKey?: string,
): string {
  const host = apiKey ? "https://customer-archive-api.open-meteo.com" : "https://archive-api.open-meteo.com";
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    hourly: HOURLY_VARIABLES.join(","),
    start_date: startDate,
    end_date: endDate,
    timezone: "GMT",
    timeformat: "unixtime",
  });
  if (apiKey) params.set("apikey", apiKey);
  return `${host}/v1/archive?${params}`;
}

function parseIsoDate(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) ? time : null;
}

export function validateBackfillRange(
  startDate: unknown,
  endDate: unknown,
  now: Date,
): { ok: true; startDate: string; endDate: string } | { ok: false; error: string } {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (start === null || end === null) {
    return { ok: false, error: "startDate and endDate must be YYYY-MM-DD" };
  }
  if (start > end) return { ok: false, error: "startDate must not be after endDate" };
  if (end > now.getTime()) return { ok: false, error: "endDate must not be in the future" };
  if ((end - start) / DAY_MS + 1 > MAX_BACKFILL_DAYS) {
    return { ok: false, error: `A backfill call covers at most ${MAX_BACKFILL_DAYS} days` };
  }
  return { ok: true, startDate: startDate as string, endDate: endDate as string };
}

function finiteOrNull(values: (number | null)[] | undefined, index: number): number | null {
  const value = values?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Converts Open-Meteo's columnar hourly arrays into one row per hour. Archive
// responses are reanalysis; for the forecast endpoint an hour that has fully
// elapsed is analysis and anything later is forecast.
export function parseHourlyWeather(
  response: OpenMeteoResponse,
  location: WeatherLocation,
  source: "forecast" | "archive",
  now: Date,
): WeatherRow[] {
  const hourly = response.hourly;
  if (!hourly?.time) return [];

  const rows: WeatherRow[] = [];
  for (let index = 0; index < hourly.time.length; index += 1) {
    const startMs = hourly.time[index] * 1000;
    if (!Number.isFinite(startMs)) continue;

    const isDay = finiteOrNull(hourly.is_day, index);
    const row: WeatherRow = {
      location_key: location.key,
      observed_at: new Date(startMs).toISOString(),
      latitude: location.latitude,
      longitude: location.longitude,
      temperature_c: finiteOrNull(hourly.temperature_2m, index),
      apparent_temperature_c: finiteOrNull(hourly.apparent_temperature, index),
      relative_humidity_pct: finiteOrNull(hourly.relative_humidity_2m, index),
      precipitation_mm: finiteOrNull(hourly.precipitation, index),
      rain_mm: finiteOrNull(hourly.rain, index),
      cloud_cover_pct: finiteOrNull(hourly.cloud_cover, index),
      wind_speed_kmh: finiteOrNull(hourly.wind_speed_10m, index),
      weather_code: finiteOrNull(hourly.weather_code, index),
      is_day: isDay === null ? null : isDay === 1,
      sunshine_duration_s: finiteOrNull(hourly.sunshine_duration, index),
      data_kind: source === "archive"
        ? "reanalysis"
        : startMs + HOUR_MS <= now.getTime()
        ? "analysis"
        : "forecast",
      provider: "open-meteo",
    };

    // The archive lags a few days behind; its newest hours arrive empty.
    if (row.temperature_c === null && row.precipitation_mm === null && row.cloud_cover_pct === null) continue;
    rows.push(row);
  }

  return rows;
}
