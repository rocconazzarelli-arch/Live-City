import {
  calculateWeatherImpact,
  type WeatherCrowdProfileInput,
  type WeatherForecastInput,
  weatherAdjustedScore,
  weatherDaypart,
} from "../supabase/functions/_shared/weather-crowd-model.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const heavyRain: WeatherForecastInput = {
  observed_at: "2026-10-27T19:00:00.000Z",
  apparent_temperature_c: 13,
  precipitation_mm: 3.2,
  rain_mm: 3.2,
  wind_speed_kmh: 12,
  sunshine_duration_s: 0,
  weather_code: 63,
  data_kind: "forecast",
};

function profile(overrides: Partial<WeatherCrowdProfileInput>): WeatherCrowdProfileInput {
  return {
    scope_type: "category",
    scope_key: "category:outdoor",
    place_id: null,
    category: "outdoor",
    daypart: "evening",
    rain_delta: -9,
    rain_samples: 20,
    heavy_rain_delta: -14,
    heavy_rain_samples: 24,
    hot_delta: null,
    hot_samples: 0,
    cold_delta: null,
    cold_samples: 0,
    strong_wind_delta: null,
    strong_wind_samples: 0,
    pleasant_delta: 6,
    pleasant_samples: 18,
    sample_count: 120,
    distinct_days: 30,
    confidence: 0.72,
    ...overrides,
  };
}

Deno.test("weather dayparts are stable and mutually exclusive", () => {
  assert(weatherDaypart(2) === "night", "02:00 must be night");
  assert(weatherDaypart(9) === "morning", "09:00 must be morning");
  assert(weatherDaypart(15) === "afternoon", "15:00 must be afternoon");
  assert(weatherDaypart(21) === "evening", "21:00 must be evening");
});

Deno.test("cold-start weather effects differ by venue category", () => {
  const outdoor = calculateWeatherImpact(1, "outdoor", 20, heavyRain, []);
  const culture = calculateWeatherImpact(2, "culture", 20, heavyRain, []);

  assert(outdoor.delta === -20, `expected outdoor heavy-rain prior -20, received ${outdoor.delta}`);
  assert(culture.delta === 2, `expected indoor culture prior +2, received ${culture.delta}`);
  assert(outdoor.source === "cold_start", "no learned profile must be labelled cold start");
  assert(weatherAdjustedScore(70, outdoor) === 50, "weather correction must adjust the historical baseline");
});

Deno.test("a mature place profile takes precedence and is shrunk towards the prior", () => {
  const categoryProfile = profile({});
  const placeProfile = profile({
    scope_type: "place",
    scope_key: "place:7",
    place_id: 7,
    heavy_rain_delta: -8,
    heavy_rain_samples: 40,
    sample_count: 90,
    distinct_days: 20,
    confidence: 0.8,
  });
  const impact = calculateWeatherImpact(7, "outdoor", 20, heavyRain, [categoryProfile, placeProfile]);

  assert(impact.source === "learned_place", "a mature place profile must win over its category");
  assert(impact.delta === -10, `85% learned and 15% prior should round to -10, received ${impact.delta}`);
  assert(impact.profileSamples === 90 && impact.profileDays === 20, "profile evidence must remain inspectable");
});

Deno.test("immature learned profiles never override the conservative prior", () => {
  const immature = profile({ sample_count: 12, distinct_days: 2, heavy_rain_delta: 15, heavy_rain_samples: 12 });
  const impact = calculateWeatherImpact(1, "outdoor", 20, heavyRain, [immature]);

  assert(impact.source === "cold_start", "immature profiles must not be used");
  assert(impact.delta === -20, "an immature positive correlation must not invert the prior");
});

Deno.test("neutral weather leaves the baseline unchanged", () => {
  const neutral: WeatherForecastInput = {
    ...heavyRain,
    apparent_temperature_c: 12,
    precipitation_mm: 0,
    rain_mm: 0,
    wind_speed_kmh: 8,
  };
  const impact = calculateWeatherImpact(1, "food", 10, neutral, []);

  assert(impact.source === "neutral", "no active weather feature must be neutral");
  assert(impact.delta === 0, "neutral weather must not alter the forecast");
});
