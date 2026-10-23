import { createClient } from "npm:@supabase/supabase-js@2";

import {
  assignEventsToPlaces,
  buildBestTimeSignal,
  buildHistoricalSignal,
  buildTelemetrySignal,
  calculateEstimate,
  type CrowdCacheInput,
  type EngineSignal,
  type EventInput,
  type HistoricalSlotInput,
  type PlaceCategory,
  type PlaceInput,
  type PresenceProfileInput,
  type PresenceSnapshotInput,
} from "../_shared/crowd-engine.ts";
import { buildHistoryRows, historyBucketStart } from "../_shared/crowd-history.ts";

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
type AreaSnapshotRow = {
  grid_key: string;
  window_start: string;
  window_end: string;
  distinct_sessions: number;
  observation_count: number;
};
type CommunityEventRow = EventInput & { expected_attendance: number };

const PRIVACY_GRID_SIZE = 0.004;

function privacyGridKey(latitude: number, longitude: number): string {
  return `${Math.floor(latitude / PRIVACY_GRID_SIZE)}:${Math.floor(longitude / PRIVACY_GRID_SIZE)}`;
}

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
    const clockParts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Rome", hour: "numeric", hourCycle: "h23", weekday: "short",
    }).formatToParts(now);
    const localHour = Number(clockParts.find((part) => part.type === "hour")?.value ?? 0);
    const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const localWeekday = weekdayMap[clockParts.find((part) => part.type === "weekday")?.value ?? ""] ?? 1;
    const [placesResult, mappingsResult, eventsResult, communityEventsResult, previousResult, areaSnapshotsResult, profilesResult, historyResult] = await Promise.all([
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
        .from("community_events")
        .select("id, place_id, category, latitude, longitude, start_at, end_at, expected_attendance, is_active")
        .eq("is_active", true)
        .gte("end_at", now.toISOString())
        .lte("start_at", eventWindowEnd),
      supabase
        .from("crowd_estimates")
        .select("place_id, score, crowd_score"),
      // Never read raw device observations here. The crowd engine may use
      // only a published, k-anonymous area snapshot, matched to a place's
      // coarse privacy cell.
      supabase
        .from("crowd_area_snapshots")
        .select("grid_key, window_start, window_end, distinct_sessions, observation_count")
        .gte("window_end", telemetryCutoff)
        .order("window_end", { ascending: false })
        .limit(1000),
      supabase
        .from("crowd_place_profiles")
        .select("place_id, p25_weighted_presence, p50_weighted_presence, p75_weighted_presence, p90_weighted_presence, max_weighted_presence, sample_count, distinct_days, confidence"),
      supabase
        .from("crowd_historical_slots")
        .select("place_id, local_weekday, local_hour, average_score, sample_count, distinct_days, besttime_samples, telemetry_samples")
        .eq("local_weekday", localWeekday)
        .eq("local_hour", localHour),
    ]);

    const readError = placesResult.error ?? mappingsResult.error ?? eventsResult.error ?? communityEventsResult.error ?? previousResult.error ?? areaSnapshotsResult.error ?? profilesResult.error ?? historyResult.error;
    if (readError) throw new Error(`Crowd Engine read failed: ${readError.message}`);

    const places = (placesResult.data ?? []) as PlaceRow[];
    const mappings = (mappingsResult.data ?? []) as MappingRow[];
    const events = [
      ...((eventsResult.data ?? []) as EventInput[]).map((event) => ({ ...event, source: "editorial" as const })),
      ...((communityEventsResult.data ?? []) as CommunityEventRow[]).map((event) => ({ ...event, source: "community" as const })),
    ];
    const previousEstimates = (previousResult.data ?? []) as PreviousEstimateRow[];
    const areaSnapshots = (areaSnapshotsResult.data ?? []) as AreaSnapshotRow[];
    const profiles = (profilesResult.data ?? []) as PresenceProfileInput[];
    const historicalSlots = (historyResult.data ?? []) as HistoricalSlotInput[];
    const venueIds = [...new Set(
      mappings
        .map((mapping) => mapping.besttime_venue_id)
        .filter((venueId): venueId is string => Boolean(venueId)),
    )];

    let cacheRows: CrowdCacheInput[] = [];
    if (venueIds.length > 0) {
      const cacheResult = await supabase
        .from("venue_crowd_cache")
        .select("besttime_venue_id, crowd_score, confidence, fetched_at, expires_at, observation_mode")
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
    const latestAreaByGrid = new Map<string, AreaSnapshotRow>();
    for (const snapshot of areaSnapshots) {
      if (!latestAreaByGrid.has(snapshot.grid_key)) latestAreaByGrid.set(snapshot.grid_key, snapshot);
    }
    const snapshotByPlaceId = new Map<number, PresenceSnapshotInput>();
    for (const place of places) {
      const area = latestAreaByGrid.get(privacyGridKey(place.latitude, place.longitude));
      if (!area) continue;
      snapshotByPlaceId.set(place.id, {
        place_id: place.id,
        window_start: area.window_start,
        window_end: area.window_end,
        confirmed_sessions: area.distinct_sessions,
        // Area-level telemetry is deliberately not presented as a precise
        // venue visit. Its intensity is the number of distinct sessions in
        // the same coarse cell, published only when k >= 5.
        weighted_presence: area.distinct_sessions,
        average_presence_confidence: 0.7,
        telemetry_observations: area.observation_count,
        telemetry_sessions: area.distinct_sessions,
        telemetry_coverage: 1,
      });
    }
    const profileByPlaceId = new Map(profiles.map((profile) => [profile.place_id, profile]));
    const historicalByPlaceId = new Map(historicalSlots.map((slot) => [slot.place_id, slot]));
    const eventSignalsByPlace = assignEventsToPlaces(places, events, now);
    const allSignals: EngineSignal[] = [];
    const estimates = [];

    for (const place of places) {
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
      const liveSignals = [
        ...(providerSignal ? [providerSignal] : []),
        ...(telemetrySignal ? [telemetrySignal] : []),
      ];
      // Predictions are built exclusively from past observed BestTime or
      // opt-in telemetry data. A generic category/hour fallback is forbidden.
      const historicalSignal = liveSignals.length === 0
        ? buildHistoricalSignal(place.id, historicalByPlaceId.get(place.id) ?? null, now)
        : null;
      const signals = [
        ...liveSignals,
        ...(historicalSignal ? [historicalSignal] : []),
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
      const historicalSignal = placeSignals.find((signal) => signal.kind === "historical");
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
        historical_score: historicalSignal?.score ?? null,
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

    // History feeds the predictive model. A failed write is reported in stats
    // but does not invalidate the estimates that were already published.
    const historyRows = buildHistoryRows(estimates, allSignals, historyBucketStart(now));
    let historyError: string | null = null;
    if (historyRows.length > 0) {
      const { error: historyUpsertError } = await supabase
        .from("crowd_history")
        .upsert(historyRows, { onConflict: "place_id,bucket_start" });
      if (historyUpsertError) {
        historyError = historyUpsertError.message;
        console.error("CROWD HISTORY WRITE ERROR", { message: historyError });
      }
    }

    const bestTimeSignals = allSignals.filter((signal) => signal.kind === "besttime");
    const telemetrySignals = allSignals.filter((signal) => signal.kind === "telemetry");
    const historicalSignals = allSignals.filter((signal) => signal.kind === "historical");
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
      areaSnapshotsRead: areaSnapshots.length,
      placeTelemetryMatches: snapshotByPlaceId.size,
      telemetrySignals: telemetrySignals.length,
      eventsRead: events.length,
      eventSignals: eventSignals.length,
      directEventSignals: eventSignals.filter((signal) => signal.metadata.match === "direct").length,
      geoEventSignals: eventSignals.filter((signal) => signal.metadata.match === "geo").length,
      historicalSlotsRead: historicalSlots.length,
      historicalPredictionSignals: historicalSignals.length,
      signalsWritten: allSignals.length,
      estimatesWritten: estimateRows.length,
      fallbackEstimates: fallbackEstimates.length,
      historyRowsWritten: historyError ? 0 : historyRows.length,
      historyError,
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
