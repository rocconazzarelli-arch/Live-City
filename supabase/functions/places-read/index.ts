import { createClient } from "npm:@supabase/supabase-js@2";

import type { PlaceCategory } from "../_shared/crowd-engine.ts";
import {
  calculateWeatherImpact,
  type WeatherCrowdProfileInput,
  type WeatherForecastInput,
  weatherAdjustedScore,
} from "../_shared/weather-crowd-model.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
    },
  });
}

function confidenceLabel(value: number | string | null): "low" | "medium" | "high" | null {
  if (value === "low" || value === "medium" || value === "high") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 0.75) return "high";
  if (value >= 0.5) return "medium";
  return "low";
}

function validScore(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100 && value !== 999;
}

type PlaceRow = {
  id: number;
  fsq_place_id: string;
  name: string;
  address: string | null;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  catalog_source: string;
};

type MappingRow = {
  fsq_place_id: string;
  besttime_venue_id: string | null;
  match_status: string;
};

type EstimateRow = {
  place_id: number;
  score: number;
  activity_level: "low" | "medium" | "high" | "very_high";
  trend: "up" | "stable" | "down";
  confidence: number;
  dominant_source: string;
  signal_count: number;
  calculated_at: string;
  valid_until: string;
  metadata: Record<string, unknown> | null;
};

type CacheRow = {
  besttime_venue_id: string;
  crowd_score: number | null;
  activity_level: "low" | "medium" | "high" | "very_high" | null;
  trend: "up" | "stable" | "down" | null;
  confidence: string | null;
  fetched_at: string;
  expires_at: string;
  observation_mode: "live" | "forecast" | "unknown" | null;
};

type HistoricalSlotRow = {
  place_id: number;
  local_weekday: number;
  local_hour: number;
  average_score: number;
  sample_count: number;
  distinct_days: number;
};

type ForecastSlot = {
  localWeekday: number;
  localHour: number;
  label: string;
  targetAt: string;
};

function nextRomeForecastSlots(now: Date): ForecastSlot[] {
  const weekdays: Record<string, number> = {
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
    Sunday: 7,
  };

  return [1, 2, 3].map((offset) => {
    const date = new Date(now.getTime() + offset * 60 * 60 * 1000);
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Rome",
      weekday: "long",
    }).format(date);
    const hour = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Rome",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(date));

    return {
      localWeekday: weekdays[weekday] ?? 1,
      localHour: hour,
      label: `${String(hour).padStart(2, "0")}:00`,
      targetAt: new Date(Math.floor(date.getTime() / 3_600_000) * 3_600_000).toISOString(),
    };
  });
}

function forecastConfidence(slot: HistoricalSlotRow): "low" | "medium" | "high" {
  if (slot.sample_count >= 48 && slot.distinct_days >= 8) return "high";
  if (slot.sample_count >= 24 && slot.distinct_days >= 5) return "medium";
  return "low";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return jsonResponse({ success: false, error: "Method not allowed" }, 405);

  try {
    const requestedStrategy = new URL(request.url).searchParams.get("strategy");
    const strategy = requestedStrategy === "hybrid" ? "hybrid" : "besttime";
    const estimateTable = strategy === "hybrid" ? "hybrid_crowd_estimates" : "crowd_estimates";
    const historicalTable = strategy === "hybrid" ? "hybrid_historical_slots" : "crowd_historical_slots";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase backend configuration is incomplete");

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const now = new Date();
    const forecastSlots = nextRomeForecastSlots(now);
    const [
      placesResult,
      mappingsResult,
      estimatesResult,
      historicalResult,
      weatherResult,
      weatherProfilesResult,
    ] = await Promise.all([
      supabase
        .from("places")
        .select("id, fsq_place_id, name, address, category, latitude, longitude, catalog_source")
        .eq("is_active", true)
        .order("id"),
      supabase
        .from("venue_mappings")
        .select("fsq_place_id, besttime_venue_id, match_status"),
      supabase
        .from(estimateTable)
        .select("place_id, score, activity_level, trend, confidence, dominant_source, signal_count, calculated_at, valid_until, metadata"),
      supabase
        .from(historicalTable)
        .select("place_id, local_weekday, local_hour, average_score, sample_count, distinct_days")
        .in("local_weekday", [...new Set(forecastSlots.map((slot) => slot.localWeekday))])
        .in("local_hour", [...new Set(forecastSlots.map((slot) => slot.localHour))]),
      supabase
        .from("weather_observations")
        .select("observed_at, apparent_temperature_c, precipitation_mm, rain_mm, wind_speed_kmh, sunshine_duration_s, weather_code, data_kind")
        .eq("location_key", "milano")
        .in("observed_at", forecastSlots.map((slot) => slot.targetAt)),
      supabase
        .from("weather_crowd_profiles")
        .select("scope_type, scope_key, place_id, category, daypart, rain_delta, rain_samples, heavy_rain_delta, heavy_rain_samples, hot_delta, hot_samples, cold_delta, cold_samples, strong_wind_delta, strong_wind_samples, pleasant_delta, pleasant_samples, sample_count, distinct_days, confidence"),
    ]);
    const readError = placesResult.error ?? mappingsResult.error ?? estimatesResult.error ??
      historicalResult.error ?? weatherResult.error ?? weatherProfilesResult.error;
    if (readError) throw new Error(readError.message);

    const places = (placesResult.data ?? []) as PlaceRow[];
    const mappings = (mappingsResult.data ?? []) as MappingRow[];
    const estimates = (estimatesResult.data ?? []) as EstimateRow[];
    const historicalSlots = (historicalResult.data ?? []) as HistoricalSlotRow[];
    const weatherRows = (weatherResult.data ?? []) as WeatherForecastInput[];
    const weatherProfiles = (weatherProfilesResult.data ?? []) as WeatherCrowdProfileInput[];
    const venueIds = mappings
      .map((mapping) => mapping.besttime_venue_id)
      .filter((venueId): venueId is string => Boolean(venueId));
    let cacheRows: CacheRow[] = [];

    if (strategy === "besttime" && venueIds.length > 0) {
      const cacheResult = await supabase
        .from("venue_crowd_cache")
        .select("besttime_venue_id, crowd_score, activity_level, trend, confidence, fetched_at, expires_at, observation_mode")
        .in("besttime_venue_id", venueIds);
      if (cacheResult.error) throw new Error(cacheResult.error.message);
      cacheRows = (cacheResult.data ?? []) as CacheRow[];
    }

    const historicalByPlaceAndSlot = new Map(
      historicalSlots.map((slot) => [
        `${slot.place_id}:${slot.local_weekday}:${slot.local_hour}`,
        slot,
      ]),
    );
    const weatherByHour = new Map(weatherRows.map((row) => [row.observed_at, row]));
    const crowdForecastFor = (place: PlaceRow) => forecastSlots.flatMap((slot) => {
      const historical = historicalByPlaceAndSlot.get(
        `${place.id}:${slot.localWeekday}:${slot.localHour}`,
      );
      if (
        !historical ||
        historical.sample_count < 12 ||
        historical.distinct_days < 3 ||
        !validScore(historical.average_score)
      ) return [];

      const baselineScore = Math.round(historical.average_score);
      const weather = weatherByHour.get(slot.targetAt);
      const impact = weather
        ? calculateWeatherImpact(place.id, place.category, slot.localHour, weather, weatherProfiles)
        : null;
      const baseConfidence = forecastConfidence(historical);
      const confidence = !impact || impact.source === "neutral"
        ? baseConfidence
        : impact.source === "learned_place" && baseConfidence === "high" && impact.confidence >= 0.65
        ? "high"
        : impact.source !== "cold_start" && baseConfidence !== "low"
        ? "medium"
        : "low";

      return [{
        time: slot.label,
        targetAt: slot.targetAt,
        score: impact ? weatherAdjustedScore(baselineScore, impact) : baselineScore,
        baselineScore,
        confidence,
        sampleCount: historical.sample_count,
        distinctDays: historical.distinct_days,
        weatherAdjustment: impact?.delta ?? 0,
        weatherSummary: impact?.summary ?? "Meteo non disponibile",
        weatherModel: impact?.source ?? null,
        weatherDataKind: impact?.dataKind ?? null,
        weatherConfidence: impact?.confidence ?? null,
      }];
    });
    const nowMs = now.getTime();
    const staleCutoffMs = nowMs - 24 * 60 * 60 * 1000;
    const estimateByPlaceId = new Map(estimates.map((estimate) => [estimate.place_id, estimate]));
    const mappingByFsqId = new Map(mappings.map((mapping) => [mapping.fsq_place_id, mapping]));
    const cacheByVenueId = new Map(cacheRows.map((cache) => [cache.besttime_venue_id, cache]));

    const resultPlaces = places.map((place) => {
      const mapping = mappingByFsqId.get(place.fsq_place_id);
      const cache = mapping?.besttime_venue_id ? cacheByVenueId.get(mapping.besttime_venue_id) : undefined;
      const estimate = estimateByPlaceId.get(place.id);
      const estimateValidUntil = estimate ? new Date(estimate.valid_until).getTime() : 0;
      const estimateCalculatedAt = estimate ? new Date(estimate.calculated_at).getTime() : 0;
      const usableEstimate = Boolean(
        estimate && Number.isFinite(estimateValidUntil) && estimateCalculatedAt >= staleCutoffMs,
      );

      if (estimate && usableEstimate && estimate.metadata?.isUnavailable === true) {
        return {
          id: place.id,
          fsqPlaceId: place.fsq_place_id,
          name: place.name,
          address: place.address,
          category: place.category,
          latitude: place.latitude,
          longitude: place.longitude,
          catalogSource: place.catalog_source,
          matched: Boolean(mapping?.besttime_venue_id),
          bestTimeVenueId: mapping?.besttime_venue_id ?? null,
          hasCachedCrowd: false,
          crowdIsStale: false,
          crowdScore: null,
          activityLevel: null,
          trend: null,
          confidence: null,
          crowdSource: null,
          crowdSources: [],
          crowdUpdatedAt: estimate.calculated_at,
          crowdValidUntil: estimate.valid_until,
          crowdIsFallback: false,
          crowdDataState: "unavailable",
          signalCount: 0,
          crowdForecast: crowdForecastFor(place),
        };
      }

      if (estimate && usableEstimate && validScore(estimate.score)) {
        const fallback = estimate.metadata?.isFallback === true;
        const stale = estimateValidUntil < nowMs;
        const rawContributions = Array.isArray(estimate.metadata?.contributions)
          ? estimate.metadata.contributions
          : [];
        const crowdSources = [...new Set(rawContributions.flatMap((contribution) => {
          if (!contribution || typeof contribution !== "object") return [];
          const kind = (contribution as Record<string, unknown>).kind;
          return typeof kind === "string" ? [kind] : [];
        }))];
        return {
          id: place.id,
          fsqPlaceId: place.fsq_place_id,
          name: place.name,
          address: place.address,
          category: place.category,
          latitude: place.latitude,
          longitude: place.longitude,
          catalogSource: place.catalog_source,
          matched: Boolean(mapping?.besttime_venue_id),
          bestTimeVenueId: mapping?.besttime_venue_id ?? null,
          hasCachedCrowd: Boolean(cache && cache.observation_mode === "live" && validScore(cache.crowd_score)),
          crowdIsStale: stale,
          crowdScore: estimate.score,
          activityLevel: estimate.activity_level,
          trend: estimate.trend,
          confidence: confidenceLabel(estimate.confidence),
          crowdSource: estimate.dominant_source,
          crowdSources,
          crowdUpdatedAt: estimate.calculated_at,
          crowdValidUntil: estimate.valid_until,
          crowdIsFallback: fallback,
          crowdDataState: fallback ? "fallback" : stale ? "stale" : "fresh",
          signalCount: estimate.signal_count,
          crowdForecast: crowdForecastFor(place),
        };
      }

      const cacheFetchedAt = cache ? new Date(cache.fetched_at).getTime() : 0;
      const usableCache = Boolean(
        cache &&
        cache.observation_mode === "live" &&
        validScore(cache.crowd_score) &&
        cacheFetchedAt >= staleCutoffMs,
      );
      if (strategy === "besttime" && cache && usableCache && validScore(cache.crowd_score)) {
        const stale = new Date(cache.expires_at).getTime() < nowMs;
        return {
          id: place.id,
          fsqPlaceId: place.fsq_place_id,
          name: place.name,
          address: place.address,
          category: place.category,
          latitude: place.latitude,
          longitude: place.longitude,
          catalogSource: place.catalog_source,
          matched: Boolean(mapping?.besttime_venue_id),
          bestTimeVenueId: mapping?.besttime_venue_id ?? null,
          hasCachedCrowd: true,
          crowdIsStale: stale,
          crowdScore: cache.crowd_score,
          activityLevel: cache.activity_level,
          trend: cache.trend,
          confidence: confidenceLabel(cache.confidence),
          crowdSource: "legacy_cache",
          crowdSources: ["besttime"],
          crowdUpdatedAt: cache.fetched_at,
          crowdValidUntil: cache.expires_at,
          crowdIsFallback: false,
          crowdDataState: stale ? "stale" : "fresh",
          signalCount: 1,
          crowdForecast: crowdForecastFor(place),
        };
      }

      return {
        id: place.id,
        fsqPlaceId: place.fsq_place_id,
        name: place.name,
        address: place.address,
        category: place.category,
        latitude: place.latitude,
        longitude: place.longitude,
        catalogSource: place.catalog_source,
        matched: Boolean(mapping?.besttime_venue_id),
        bestTimeVenueId: mapping?.besttime_venue_id ?? null,
        hasCachedCrowd: false,
        crowdIsStale: false,
        crowdScore: null,
        activityLevel: null,
        trend: null,
        confidence: null,
        crowdSource: null,
        crowdSources: [],
        crowdUpdatedAt: null,
        crowdValidUntil: null,
        crowdIsFallback: false,
        crowdDataState: "unavailable",
        signalCount: 0,
        crowdForecast: crowdForecastFor(place),
      };
    });

    const available = resultPlaces.filter((place) => place.crowdScore !== null);
    const stats = {
      count: resultPlaces.length,
      matchedCount: resultPlaces.filter((place) => place.matched).length,
      availableCrowdCount: available.length,
      liveEstimateCount: available.filter((place) => place.crowdDataState === "fresh" && !place.crowdIsFallback).length,
      forecastEstimateCount: available.filter((place) => place.crowdIsFallback).length,
      staleEstimateCount: available.filter((place) => place.crowdDataState === "stale").length,
      unavailableCrowdCount: resultPlaces.length - available.length,
      weatherForecastHoursRead: weatherRows.length,
      weatherProfilesRead: weatherProfiles.length,
    };

    console.log("PLACES READ COMPLETATO", { strategy, ...stats });
    return jsonResponse({ success: true, strategy, ...stats, places: resultPlaces });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown places-read error";
    console.error("PLACES READ ERROR", { message });
    return jsonResponse({ success: false, error: message }, 500);
  }
});
