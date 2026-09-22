import { createClient } from "npm:@supabase/supabase-js@2";

import {
  assignEventsToPlaces,
  buildBestTimeSignal,
  buildTelemetrySignal,
  buildTemporalSignal,
  calculateEstimate,
  type CrowdCacheInput,
  type EngineSignal,
  type EventInput,
  type PlaceCategory,
  type PlaceInput,
  type PresenceProfileInput,
  type PresenceSnapshotInput,
} from "../_shared/crowd-engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-refresh-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

type PlaceRow = PlaceInput;
type MappingRow = {
  fsq_place_id: string;
  besttime_venue_id: string | null;
  match_status: string;
};
type PreviousEstimateRow = {
  place_id: number;
  score: number | null;
  crowd_score: number | null;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405);

  const startedAt = Date.now();

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const configuredRefreshSecret = Deno.env.get("CROWD_ENGINE_REFRESH_SECRET");
    const serviceRoleAuthorized =
      request.headers.get("Authorization") === `Bearer ${serviceRoleKey}` ||
      request.headers.get("apikey") === serviceRoleKey;
    const refreshSecretAuthorized = Boolean(
      configuredRefreshSecret && request.headers.get("x-refresh-secret") === configuredRefreshSecret,
    );

    if (!serviceRoleAuthorized && !refreshSecretAuthorized) {
      return jsonResponse({ ok: false, error: "Unauthorized refresh request" }, 401);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const now = new Date();
    const eventWindowEnd = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();

    const telemetryCutoff = new Date(now.getTime() - 40 * 60 * 1000).toISOString();
    const [placesResult, mappingsResult, eventsResult, previousResult, snapshotsResult, profilesResult] = await Promise.all([
      supabase
        .from("places")
        .select("id, fsq_place_id, category, latitude, longitude")
        .eq("is_active", true)
        .order("id"),
      supabase
        .from("venue_mappings")
        .select("fsq_place_id, besttime_venue_id, match_status")
        .not("besttime_venue_id", "is", null),
      supabase
        .from("events")
        .select("id, place_id, category, latitude, longitude, start_at, end_at, is_active")
        .eq("is_active", true)
        .gte("end_at", now.toISOString())
        .lte("start_at", eventWindowEnd),
      supabase
        .from("crowd_estimates")
        .select("place_id, score, crowd_score"),
      supabase
        .from("crowd_snapshots")
        .select("place_id, window_start, window_end, confirmed_sessions, weighted_presence, average_presence_confidence, telemetry_observations, telemetry_sessions, telemetry_coverage")
        .gte("window_end", telemetryCutoff)
        .order("window_end", { ascending: false })
        .limit(1000),
      supabase
        .from("crowd_place_profiles")
        .select("place_id, p25_weighted_presence, p50_weighted_presence, p75_weighted_presence, p90_weighted_presence, max_weighted_presence, sample_count, distinct_days, confidence"),
    ]);

    const readError = placesResult.error ?? mappingsResult.error ?? eventsResult.error ?? previousResult.error ?? snapshotsResult.error ?? profilesResult.error;
    if (readError) throw new Error(`Crowd Engine read failed: ${readError.message}`);

    const places = (placesResult.data ?? []) as PlaceRow[];
    const mappings = (mappingsResult.data ?? []) as MappingRow[];
    const events = (eventsResult.data ?? []) as EventInput[];
    const previousEstimates = (previousResult.data ?? []) as PreviousEstimateRow[];
    const snapshots = (snapshotsResult.data ?? []) as PresenceSnapshotInput[];
    const profiles = (profilesResult.data ?? []) as PresenceProfileInput[];
    const venueIds = [...new Set(
      mappings
        .map((mapping) => mapping.besttime_venue_id)
        .filter((venueId): venueId is string => Boolean(venueId)),
    )];

    let cacheRows: CrowdCacheInput[] = [];
    if (venueIds.length > 0) {
      const cacheResult = await supabase
        .from("venue_crowd_cache")
        .select("besttime_venue_id, crowd_score, confidence, fetched_at, expires_at")
        .in("besttime_venue_id", venueIds);
      if (cacheResult.error) throw new Error(`Crowd cache read failed: ${cacheResult.error.message}`);
      cacheRows = (cacheResult.data ?? []) as CrowdCacheInput[];
    }

    const mappingByFsqId = new Map(
      mappings
        .filter((mapping) => mapping.besttime_venue_id)
        .map((mapping) => [mapping.fsq_place_id, mapping.besttime_venue_id as string]),
    );
    const cacheByVenueId = new Map(cacheRows.map((row) => [row.besttime_venue_id, row]));
    const previousByPlaceId = new Map(
      previousEstimates.map((estimate) => [estimate.place_id, estimate.score ?? estimate.crowd_score]),
    );
    const snapshotByPlaceId = new Map<number, PresenceSnapshotInput>();
    for (const snapshot of snapshots) {
      if (!snapshotByPlaceId.has(snapshot.place_id)) snapshotByPlaceId.set(snapshot.place_id, snapshot);
    }
    const profileByPlaceId = new Map(profiles.map((profile) => [profile.place_id, profile]));
    const eventSignalsByPlace = assignEventsToPlaces(places, events, now);
    const allSignals: EngineSignal[] = [];
    const estimates = [];

    for (const place of places) {
      const temporalSignal = buildTemporalSignal(place, now);
      const providerVenueId = mappingByFsqId.get(place.fsq_place_id);
      const providerSignal = buildBestTimeSignal(
        place.id,
        providerVenueId ? cacheByVenueId.get(providerVenueId) ?? null : null,
        now,
      );
      const telemetrySignal = buildTelemetrySignal(
        place.id,
        snapshotByPlaceId.get(place.id) ?? null,
        profileByPlaceId.get(place.id) ?? null,
        now,
      );
      const signals = [
        temporalSignal,
        ...(providerSignal ? [providerSignal] : []),
        ...(telemetrySignal ? [telemetrySignal] : []),
        ...(eventSignalsByPlace.get(place.id) ?? []),
      ];
      allSignals.push(...signals);
      estimates.push(calculateEstimate(place.id, signals, previousByPlaceId.get(place.id) ?? null, now));
    }

    if (allSignals.length > 0) {
      const { error: signalInsertError } = await supabase.from("crowd_signals").insert(
        allSignals.map((signal) => ({
          place_id: signal.placeId,
          source: signal.source,
          signal_type: signal.signalType,
          score: signal.score,
          weight: signal.weight,
          confidence: signal.confidence,
          observed_at: signal.observedAt,
          valid_until: signal.validUntil,
          expires_at: signal.validUntil,
          target_at: now.toISOString(),
          metadata: { ...signal.metadata, kind: signal.kind },
        })),
      );
      if (signalInsertError) throw new Error(`Signal insert failed: ${signalInsertError.message}`);
    }

    const estimateRows = estimates.map((estimate) => {
      const placeSignals = allSignals.filter((signal) => signal.placeId === estimate.placeId);
      const providerSignal = placeSignals.find((signal) => signal.kind === "besttime");
      const telemetrySignal = placeSignals.find((signal) => signal.kind === "telemetry");
      const temporalSignal = placeSignals.find((signal) => signal.kind === "temporal");
      return {
        place_id: estimate.placeId,
        estimate_type: "live",
        target_at: estimate.calculatedAt,
        crowd_score: estimate.score,
        score: estimate.score,
        activity_level: estimate.activityLevel,
        trend: estimate.trend,
        confidence: estimate.confidence,
        live_signal_score: telemetrySignal?.score ?? providerSignal?.score ?? null,
        historical_score: temporalSignal?.score ?? null,
        external_forecast_score: null,
        sample_size: estimate.signalCount,
        dominant_source: estimate.dominantSource,
        signal_count: estimate.signalCount,
        generated_at: estimate.calculatedAt,
        calculated_at: estimate.calculatedAt,
        expires_at: estimate.validUntil,
        valid_until: estimate.validUntil,
        metadata: estimate.metadata,
        updated_at: estimate.calculatedAt,
      };
    });

    if (estimateRows.length > 0) {
      const { error: estimateUpsertError } = await supabase
        .from("crowd_estimates")
        .upsert(estimateRows, { onConflict: "place_id" });
      if (estimateUpsertError) throw new Error(`Estimate upsert failed: ${estimateUpsertError.message}`);
    }

    const bestTimeSignals = allSignals.filter((signal) => signal.kind === "besttime");
    const telemetrySignals = allSignals.filter((signal) => signal.kind === "telemetry");
    const eventSignals = allSignals.filter((signal) => signal.kind === "event");
    const fallbackEstimates = estimates.filter((estimate) => estimate.metadata.isFallback === true);
    const sourceCounts = estimates.reduce<Record<string, number>>((counts, estimate) => {
      counts[estimate.dominantSource] = (counts[estimate.dominantSource] ?? 0) + 1;
      return counts;
    }, {});

    const stats = {
      placesRead: places.length,
      mappingsRead: mappings.length,
      cacheRowsRead: cacheRows.length,
      bestTimeSignals: bestTimeSignals.length,
      freshBestTimeSignals: bestTimeSignals.filter((signal) => signal.metadata.stale !== true).length,
      staleBestTimeSignals: bestTimeSignals.filter((signal) => signal.metadata.stale === true).length,
      telemetrySnapshotsRead: snapshots.length,
      telemetrySignals: telemetrySignals.length,
      eventsRead: events.length,
      eventSignals: eventSignals.length,
      directEventSignals: eventSignals.filter((signal) => signal.metadata.match === "direct").length,
      geoEventSignals: eventSignals.filter((signal) => signal.metadata.match === "geo").length,
      temporalSignals: places.length,
      signalsWritten: allSignals.length,
      estimatesWritten: estimateRows.length,
      fallbackEstimates: fallbackEstimates.length,
      dominantSources: sourceCounts,
      durationMs: Date.now() - startedAt,
    };

    console.log("CROWD ENGINE REFRESH COMPLETATO", stats);
    return jsonResponse({ ok: true, calculatedAt: now.toISOString(), stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Crowd Engine error";
    console.error("CROWD ENGINE REFRESH ERROR", { message });
    return jsonResponse({ ok: false, error: message, durationMs: Date.now() - startedAt }, 500);
  }
});
