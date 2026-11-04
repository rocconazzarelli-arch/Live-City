import { clamp, type PlaceCategory } from "./crowd-engine.ts";
import type { WeatherDataKind } from "./weather.ts";

export type WeatherDaypart = "night" | "morning" | "afternoon" | "evening";
export type WeatherModelSource = "learned_place" | "learned_category" | "cold_start" | "neutral";

export type WeatherForecastInput = {
  observed_at: string;
  apparent_temperature_c: number | null;
  precipitation_mm: number | null;
  rain_mm: number | null;
  wind_speed_kmh: number | null;
  sunshine_duration_s: number | null;
  weather_code: number | null;
  data_kind: WeatherDataKind;
};

export type WeatherCrowdProfileInput = {
  scope_type: "place" | "category";
  scope_key: string;
  place_id: number | null;
  category: PlaceCategory | null;
  daypart: WeatherDaypart;
  rain_delta: number | null;
  rain_samples: number;
  heavy_rain_delta: number | null;
  heavy_rain_samples: number;
  hot_delta: number | null;
  hot_samples: number;
  cold_delta: number | null;
  cold_samples: number;
  strong_wind_delta: number | null;
  strong_wind_samples: number;
  pleasant_delta: number | null;
  pleasant_samples: number;
  sample_count: number;
  distinct_days: number;
  confidence: number;
};

export type WeatherImpact = {
  delta: number;
  source: WeatherModelSource;
  summary: string;
  confidence: number;
  dataKind: WeatherDataKind;
  profileSamples: number;
  profileDays: number;
  activeFeatures: string[];
};

type Coefficients = {
  rain: number;
  heavyRain: number;
  hot: number;
  cold: number;
  strongWind: number;
  pleasant: number;
};

// These priors are deliberately modest. They provide a transparent cold
// start and are replaced feature-by-feature once LIVE CITY has enough
// observed residuals for the category or the venue itself.
const COLD_START: Record<PlaceCategory, Coefficients> = {
  outdoor: { rain: -12, heavyRain: -20, hot: -8, cold: -8, strongWind: -7, pleasant: 8 },
  aperitivo: { rain: -7, heavyRain: -13, hot: -3, cold: -4, strongWind: -4, pleasant: 5 },
  food: { rain: 2, heavyRain: -2, hot: -1, cold: 1, strongWind: -2, pleasant: 1 },
  nightlife: { rain: -2, heavyRain: -6, hot: -1, cold: -1, strongWind: -2, pleasant: 1 },
  culture: { rain: 5, heavyRain: 2, hot: 2, cold: 2, strongWind: 1, pleasant: -2 },
};

export function weatherDaypart(localHour: number): WeatherDaypart {
  if (localHour < 6) return "night";
  if (localHour < 12) return "morning";
  if (localHour < 18) return "afternoon";
  return "evening";
}

function finite(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function profileFor(
  placeId: number,
  category: PlaceCategory,
  daypart: WeatherDaypart,
  profiles: WeatherCrowdProfileInput[],
): WeatherCrowdProfileInput | null {
  const place = profiles.find((profile) =>
    profile.scope_type === "place" &&
    profile.place_id === placeId &&
    profile.daypart === daypart &&
    profile.sample_count >= 30 &&
    profile.distinct_days >= 7
  );
  if (place) return place;

  return profiles.find((profile) =>
    profile.scope_type === "category" &&
    profile.category === category &&
    profile.daypart === daypart &&
    profile.sample_count >= 60 &&
    profile.distinct_days >= 10
  ) ?? null;
}

function learnedOrPrior(
  profile: WeatherCrowdProfileInput | null,
  value: number | null,
  samples: number,
  prior: number,
): { value: number; learned: boolean } {
  if (profile && samples >= 8 && finite(value) !== null) {
    // Shrink young learned coefficients towards the conservative prior. This
    // avoids large swings caused by a handful of unusual days.
    const learnedShare = clamp((samples - 8) / 32, 0.25, 0.85);
    return {
      value: (value as number) * learnedShare + prior * (1 - learnedShare),
      learned: true,
    };
  }
  return { value: prior, learned: false };
}

export function calculateWeatherImpact(
  placeId: number,
  category: PlaceCategory,
  localHour: number,
  weather: WeatherForecastInput,
  profiles: WeatherCrowdProfileInput[],
): WeatherImpact {
  const apparent = finite(weather.apparent_temperature_c);
  const precipitation = Math.max(
    finite(weather.precipitation_mm) ?? 0,
    finite(weather.rain_mm) ?? 0,
  );
  const wind = finite(weather.wind_speed_kmh) ?? 0;
  const sunshine = finite(weather.sunshine_duration_s) ?? 0;
  const heavyRain = precipitation >= 2;
  const rain = precipitation >= 0.1;
  const hot = apparent !== null && apparent >= 29;
  const cold = apparent !== null && apparent <= 7;
  const strongWind = wind >= 25;
  const pleasant = !rain && apparent !== null && apparent >= 15 && apparent <= 25 && wind < 20 && sunshine >= 900;
  const daypart = weatherDaypart(localHour);
  const profile = profileFor(placeId, category, daypart, profiles);
  const prior = COLD_START[category];
  const activeFeatures: string[] = [];
  let delta = 0;
  let learnedFeatures = 0;

  if (heavyRain) {
    const coefficient = learnedOrPrior(
      profile,
      profile?.heavy_rain_delta ?? null,
      profile?.heavy_rain_samples ?? 0,
      prior.heavyRain,
    );
    delta += coefficient.value;
    learnedFeatures += Number(coefficient.learned);
    activeFeatures.push("heavy_rain");
  } else if (rain) {
    const coefficient = learnedOrPrior(
      profile,
      profile?.rain_delta ?? null,
      profile?.rain_samples ?? 0,
      prior.rain,
    );
    delta += coefficient.value;
    learnedFeatures += Number(coefficient.learned);
    activeFeatures.push("rain");
  }

  for (const feature of [
    { active: hot, key: "hot", value: profile?.hot_delta ?? null, samples: profile?.hot_samples ?? 0, prior: prior.hot },
    { active: cold, key: "cold", value: profile?.cold_delta ?? null, samples: profile?.cold_samples ?? 0, prior: prior.cold },
    { active: strongWind, key: "strong_wind", value: profile?.strong_wind_delta ?? null, samples: profile?.strong_wind_samples ?? 0, prior: prior.strongWind },
    { active: pleasant, key: "pleasant", value: profile?.pleasant_delta ?? null, samples: profile?.pleasant_samples ?? 0, prior: prior.pleasant },
  ]) {
    if (!feature.active) continue;
    const coefficient = learnedOrPrior(profile, feature.value, feature.samples, feature.prior);
    delta += coefficient.value;
    learnedFeatures += Number(coefficient.learned);
    activeFeatures.push(feature.key);
  }

  const roundedDelta = Math.round(clamp(delta, -25, 15));
  const source: WeatherModelSource = activeFeatures.length === 0
    ? "neutral"
    : profile && learnedFeatures > 0
    ? profile.scope_type === "place" ? "learned_place" : "learned_category"
    : "cold_start";
  const summary = heavyRain
    ? "Pioggia intensa"
    : rain
    ? "Pioggia"
    : hot
    ? "Caldo intenso"
    : cold
    ? "Freddo intenso"
    : strongWind
    ? "Vento forte"
    : pleasant
    ? "Meteo favorevole"
    : "Meteo neutro";

  return {
    delta: roundedDelta,
    source,
    summary,
    confidence: source === "learned_place"
      ? clamp(profile?.confidence ?? 0.45, 0.45, 0.85)
      : source === "learned_category"
      ? clamp(profile?.confidence ?? 0.4, 0.4, 0.75)
      : source === "cold_start"
      ? 0.35
      : 0.5,
    dataKind: weather.data_kind,
    profileSamples: profile?.sample_count ?? 0,
    profileDays: profile?.distinct_days ?? 0,
    activeFeatures,
  };
}

export function weatherAdjustedScore(baselineScore: number, impact: WeatherImpact): number {
  return Math.round(clamp(baselineScore + impact.delta));
}
