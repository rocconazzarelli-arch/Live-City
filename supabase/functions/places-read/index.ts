import { createClient } from "npm:@supabase/supabase-js@2";

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
  category: string;
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
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return jsonResponse({ success: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase backend configuration is incomplete");

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [placesResult, mappingsResult, estimatesResult] = await Promise.all([
      supabase
        .from("places")
        .select("id, fsq_place_id, name, address, category, latitude, longitude, catalog_source")
        .eq("is_active", true)
        .order("id"),
      supabase
        .from("venue_mappings")
        .select("fsq_place_id, besttime_venue_id, match_status"),
      supabase
        .from("crowd_estimates")
        .select("place_id, score, activity_level, trend, confidence, dominant_source, signal_count, calculated_at, valid_until, metadata"),
    ]);
    const readError = placesResult.error ?? mappingsResult.error ?? estimatesResult.error;
    if (readError) throw new Error(readError.message);

    const places = (placesResult.data ?? []) as PlaceRow[];
    const mappings = (mappingsResult.data ?? []) as MappingRow[];
    const estimates = (estimatesResult.data ?? []) as EstimateRow[];
    const venueIds = mappings
      .map((mapping) => mapping.besttime_venue_id)
      .filter((venueId): venueId is string => Boolean(venueId));
    let cacheRows: CacheRow[] = [];

    if (venueIds.length > 0) {
      const cacheResult = await supabase
        .from("venue_crowd_cache")
        .select("besttime_venue_id, crowd_score, activity_level, trend, confidence, fetched_at, expires_at")
        .in("besttime_venue_id", venueIds);
      if (cacheResult.error) throw new Error(cacheResult.error.message);
      cacheRows = (cacheResult.data ?? []) as CacheRow[];
    }

    const nowMs = Date.now();
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

      if (estimate && usableEstimate && validScore(estimate.score)) {
        const fallback = estimate.metadata?.isFallback === true;
        const stale = estimateValidUntil < nowMs;
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
          hasCachedCrowd: Boolean(cache && validScore(cache.crowd_score)),
          crowdIsStale: stale,
          crowdScore: estimate.score,
          activityLevel: estimate.activity_level,
          trend: estimate.trend,
          confidence: confidenceLabel(estimate.confidence),
          crowdSource: estimate.dominant_source,
          crowdUpdatedAt: estimate.calculated_at,
          crowdValidUntil: estimate.valid_until,
          crowdIsFallback: fallback,
          crowdDataState: fallback ? "fallback" : stale ? "stale" : "fresh",
          signalCount: estimate.signal_count,
        };
      }

      const cacheFetchedAt = cache ? new Date(cache.fetched_at).getTime() : 0;
      const usableCache = Boolean(cache && validScore(cache.crowd_score) && cacheFetchedAt >= staleCutoffMs);
      if (cache && usableCache && validScore(cache.crowd_score)) {
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
          crowdUpdatedAt: cache.fetched_at,
          crowdValidUntil: cache.expires_at,
          crowdIsFallback: false,
          crowdDataState: stale ? "stale" : "fresh",
          signalCount: 1,
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
        crowdUpdatedAt: null,
        crowdValidUntil: null,
        crowdIsFallback: false,
        crowdDataState: "unavailable",
        signalCount: 0,
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
    };

    console.log("PLACES READ COMPLETATO", stats);
    return jsonResponse({ success: true, ...stats, places: resultPlaces });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown places-read error";
    console.error("PLACES READ ERROR", { message });
    return jsonResponse({ success: false, error: message }, 500);
  }
});
