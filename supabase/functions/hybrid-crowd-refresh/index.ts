import { createClient } from "npm:@supabase/supabase-js@2";

import {
  assignEventsToPlaces,
  buildHistoricalSignal,
  buildMobilitySignal,
  buildTelemetrySignal,
  calculateHybridEstimate,
  type EngineSignal,
  type EventInput,
  type HistoricalSlotInput,
  type MobilityProfileInput,
  type PlaceInput,
  type PresenceProfileInput,
  type PresenceSnapshotInput,
} from "../_shared/crowd-engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-refresh-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PRIVACY_GRID_SIZE = 0.004;

type PreviousEstimateRow = { place_id: number; score: number };
type AreaSnapshotRow = {
  grid_key: string;
  window_start: string;
  window_end: string;
  distinct_sessions: number;
  observation_count: number;
};
type HybridHistoricalRow = {
  place_id: number;
  local_weekday: number;
  local_hour: number;
  average_score: number;
  sample_count: number;
  distinct_days: number;
};
type CommunityEventRow = EventInput & { expected_attendance: number };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function gridKey(latitude: number, longitude: number): string {
  return `${Math.floor(latitude / PRIVACY_GRID_SIZE)}:${Math.floor(longitude / PRIVACY_GRID_SIZE)}`;
}

function romeSlot(now: Date): { weekday: number; hour: number; dayType: "L" | "S" | "F" } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  const weekday = weekdayMap[parts.find((part) => part.type === "weekday")?.value ?? ""] ?? 1;
  return {
    weekday,
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0),
    dayType: weekday <= 5 ? "L" : weekday === 6 ? "S" : "F",
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const startedAt = Date.now();
  try {
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const configuredSecret = requiredEnv("CROWD_PIPELINE_SECRET");
    const serviceRoleAuthorized =
      request.headers.get("Authorization") === `Bearer ${serviceRoleKey}` ||
      request.headers.get("apikey") === serviceRoleKey;
    const refreshSecretAuthorized = request.headers.get("x-refresh-secret") === configuredSecret;
    if (!serviceRoleAuthorized && !refreshSecretAuthorized) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    const supabase = createClient(requiredEnv("SUPABASE_URL"), serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const now = new Date();
    const slot = romeSlot(now);
    const telemetryCutoff = new Date(now.getTime() - 40 * 60 * 1000).toISOString();
    const eventWindowEnd = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();

    const [
      placesResult,
      eventsResult,
      communityEventsResult,
      previousResult,
      areaSnapshotsResult,
      profilesResult,
      historyResult,
      mobilityResult,
    ] = await Promise.all([
      supabase
        .from("places")
        .select("id, fsq_place_id, category, latitude, longitude")
        .eq("is_active", true)
        .order("id"),
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
      supabase.from("hybrid_crowd_estimates").select("place_id, score"),
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
        .from("hybrid_historical_slots")
        .select("place_id, local_weekday, local_hour, average_score, sample_count, distinct_days")
        .eq("local_weekday", slot.weekday)
        .eq("local_hour", slot.hour),
      supabase
        .from("mobility_cell_profiles")
        .select("grid_key, local_day_type, local_hour, service_intensity, mobility_score, stop_count, source_updated_at, refreshed_at")
        .eq("local_day_type", slot.dayType)
        .eq("local_hour", slot.hour),
    ]);

    const readError = placesResult.error ?? eventsResult.error ?? communityEventsResult.error ??
      previousResult.error ?? areaSnapshotsResult.error ?? profilesResult.error ??
      historyResult.error ?? mobilityResult.error;
    if (readError) throw new Error(`Hybrid Crowd Engine read failed: ${readError.message}`);

    const places = (placesResult.data ?? []) as PlaceInput[];
    const events = [
      ...((eventsResult.data ?? []) as EventInput[]).map((event) => ({ ...event, source: "editorial" as const })),
      ...((communityEventsResult.data ?? []) as CommunityEventRow[]).map((event) => ({ ...event, source: "community" as const })),
    ];
    const previousByPlaceId = new Map(
      ((previousResult.data ?? []) as PreviousEstimateRow[]).map((row) => [row.place_id, row.score]),
    );
    const profileByPlaceId = new Map(
      ((profilesResult.data ?? []) as PresenceProfileInput[]).map((profile) => [profile.place_id, profile]),
    );
    const historicalByPlaceId = new Map(
      ((historyResult.data ?? []) as HybridHistoricalRow[]).map((history) => [
        history.place_id,
        {
          ...history,
          besttime_samples: 0,
          telemetry_samples: history.sample_count,
        } satisfies HistoricalSlotInput,
      ]),
    );
    const mobilityByGrid = new Map(
      ((mobilityResult.data ?? []) as MobilityProfileInput[]).map((profile) => [profile.grid_key, profile]),
    );
    const latestAreaByGrid = new Map<string, AreaSnapshotRow>();
    for (const area of (areaSnapshotsResult.data ?? []) as AreaSnapshotRow[]) {
      if (!latestAreaByGrid.has(area.grid_key)) latestAreaByGrid.set(area.grid_key, area);
    }

    const snapshotByPlaceId = new Map<number, PresenceSnapshotInput>();
    for (const place of places) {
      const area = latestAreaByGrid.get(gridKey(place.latitude, place.longitude));
      if (!area) continue;
      snapshotByPlaceId.set(place.id, {
        place_id: place.id,
        window_start: area.window_start,
        window_end: area.window_end,
        confirmed_sessions: area.distinct_sessions,
        weighted_presence: area.distinct_sessions,
        average_presence_confidence: 0.7,
        telemetry_observations: area.observation_count,
        telemetry_sessions: area.distinct_sessions,
        telemetry_coverage: 1,
      });
    }

    const eventSignalsByPlace = assignEventsToPlaces(places, events, now);
    const allSignals: EngineSignal[] = [];
    const estimates = [];

    for (const place of places) {
      const telemetry = buildTelemetrySignal(
        place.id,
        snapshotByPlaceId.get(place.id) ?? null,
        profileByPlaceId.get(place.id) ?? null,
        now,
      );
      const historical = telemetry
        ? null
        : buildHistoricalSignal(place.id, historicalByPlaceId.get(place.id) ?? null, now);
      const mobility = buildMobilitySignal(
        place.id,
        mobilityByGrid.get(gridKey(place.latitude, place.longitude)) ?? null,
        now,
      );
      const signals = [
        ...(telemetry ? [telemetry] : []),
        ...(historical ? [historical] : []),
        ...(mobility ? [mobility] : []),
        ...(eventSignalsByPlace.get(place.id) ?? []),
      ];
      allSignals.push(...signals);
      estimates.push(calculateHybridEstimate(
        place.id,
        signals,
        previousByPlaceId.get(place.id) ?? null,
        now,
      ));
    }

    if (allSignals.length > 0) {
      const { error } = await supabase.from("hybrid_crowd_signals").insert(
        allSignals.map((signal) => ({
          place_id: signal.placeId,
          signal_kind: signal.kind,
          signal_type: signal.signalType,
          score: signal.score,
          weight: signal.weight,
          confidence: signal.confidence,
          observed_at: signal.observedAt,
          valid_until: signal.validUntil,
          metadata: signal.metadata,
        })),
      );
      if (error) throw new Error(`Hybrid signal insert failed: ${error.message}`);
    }

    const estimateRows = estimates.map((estimate) => ({
      place_id: estimate.placeId,
      score: estimate.score,
      activity_level: estimate.activityLevel,
      trend: estimate.trend,
      confidence: estimate.confidence,
      dominant_source: estimate.dominantSource,
      signal_count: estimate.signalCount,
      calculated_at: estimate.calculatedAt,
      valid_until: estimate.validUntil,
      metadata: estimate.metadata,
      updated_at: estimate.calculatedAt,
    }));
    if (estimateRows.length > 0) {
      const { error } = await supabase
        .from("hybrid_crowd_estimates")
        .upsert(estimateRows, { onConflict: "place_id" });
      if (error) throw new Error(`Hybrid estimate upsert failed: ${error.message}`);
    }

    const stats = {
      strategy: "hybrid",
      placesRead: places.length,
      telemetrySignals: allSignals.filter((signal) => signal.kind === "telemetry").length,
      mobilitySignals: allSignals.filter((signal) => signal.kind === "mobility").length,
      historicalSignals: allSignals.filter((signal) => signal.kind === "historical").length,
      eventSignals: allSignals.filter((signal) => signal.kind === "event").length,
      estimatesWritten: estimateRows.length,
      unavailableEstimates: estimates.filter((estimate) => estimate.metadata.isUnavailable === true).length,
      bestTimeSignals: 0,
      durationMs: Date.now() - startedAt,
    };
    console.log("HYBRID CROWD ENGINE REFRESH COMPLETATO", stats);
    return json({ ok: true, calculatedAt: now.toISOString(), stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Hybrid Crowd Engine error";
    console.error("HYBRID CROWD ENGINE REFRESH ERROR", { message });
    return json({ ok: false, error: message, durationMs: Date.now() - startedAt }, 500);
  }
});
