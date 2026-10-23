import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
    },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase backend configuration is incomplete");

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const [catalogResult, estimateResult, liveCacheResult, areaResult, providerRunResult, forecastSlotResult, telemetryResult] = await Promise.all([
      supabase.from("places").select("id", { count: "exact", head: true }).eq("is_active", true),
      supabase.from("crowd_estimates").select("calculated_at:calculated_at").order("calculated_at", { ascending: false }).limit(1),
      supabase
        .from("venue_crowd_cache")
        .select("fetched_at:fetched_at")
        .eq("observation_mode", "live")
        .order("fetched_at", { ascending: false })
        .limit(1),
      supabase
        .from("crowd_area_snapshots")
        .select("window_end:window_end")
        .order("window_end", { ascending: false })
        .limit(1),
      supabase
        .from("crowd_provider_runs")
        .select("completed_at, requested_count, live_written_count, unavailable_count, failure_count, status, metadata")
        .eq("provider", "besttime")
        .order("completed_at", { ascending: false })
        .limit(1),
      supabase
        .from("crowd_historical_slots")
        .select("place_id", { count: "exact", head: true })
        .gte("sample_count", 12)
        .gte("distinct_days", 3),
      supabase
        .from("location_observations")
        .select("id", { count: "exact", head: true })
        .eq("consent_version", "2026-10-private-beta-1")
        .gte("observed_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    ]);

    // Health reporting must remain readable even if one non-critical metric is
    // unavailable (for example during a migration). Otherwise a diagnostic
    // endpoint hides the exact issue it is meant to reveal.
    const queryErrors: Array<[string, { message: string } | null]> = [
      ["catalog", catalogResult.error],
      ["estimates", estimateResult.error],
      ["live_cache", liveCacheResult.error],
      ["area_heatmap", areaResult.error],
      ["provider_runs", providerRunResult.error],
      ["forecast_slots", forecastSlotResult.error],
      ["telemetry", telemetryResult.error],
    ];
    const diagnostics = queryErrors.flatMap(([source, error]) =>
      error ? [{ source, error: error.message || "Query failed without a message" }] : [],
    );

    const now = Date.now();
    const latestLiveAt = liveCacheResult.data?.[0]?.fetched_at ?? null;
    const latestAreaAt = areaResult.data?.[0]?.window_end ?? null;
    const latestEstimateAt = estimateResult.data?.[0]?.calculated_at ?? null;
    const latestProviderRun = providerRunResult.data?.[0] ?? null;

    return json({
      success: true,
      degraded: diagnostics.length > 0,
      diagnostics,
      generatedAt: new Date(now).toISOString(),
      catalog: { activePlaces: catalogResult.count ?? 0 },
      crowd: {
        latestEstimateAt,
        latestLiveObservationAt: latestLiveAt,
        liveObservationFresh: latestLiveAt !== null && now - new Date(latestLiveAt).getTime() <= 90 * 60 * 1000,
        latestProviderRun,
      },
      heatmap: {
        latestAggregateAt: latestAreaAt,
        aggregateFresh: latestAreaAt !== null && now - new Date(latestAreaAt).getTime() <= 40 * 60 * 1000,
        privacyThreshold: 5,
        optedInObservationsLast24h: telemetryResult.count ?? 0,
      },
      forecasts: { eligibleHistoricalSlots: forecastSlotResult.count ?? 0 },
    });
  } catch (error) {
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});
