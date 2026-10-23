import { createClient } from "npm:@supabase/supabase-js@2";

const BESTTIME_LIVE_URL = "https://besttime.app/api/v1/forecasts/live";
const MAX_VENUES_PER_REFRESH = 100;
const REQUEST_TIMEOUT_MS = 12_000;
const PARALLEL_REQUESTS = 8;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

type MappingRow = {
  besttime_venue_id: string;
  live_priority: number;
};

type BestTimeLiveResponse = {
  status?: string;
  analysis?: {
    venue_live_busyness?: unknown;
    venue_live_busyness_available?: unknown;
  };
};

type RefreshOutcome =
  | { kind: "live"; venueId: string; score: number }
  | { kind: "unavailable"; venueId: string }
  | { kind: "failed"; venueId: string; reason: string };

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 && value !== 999;
}

function activityLevel(score: number): "low" | "medium" | "high" | "very_high" {
  if (score >= 75) return "very_high";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

async function fetchLiveVenue(
  venueId: string,
  apiKey: string,
): Promise<RefreshOutcome> {
  try {
    const url = new URL(BESTTIME_LIVE_URL);
    url.searchParams.set("api_key_private", apiKey);
    url.searchParams.set("venue_id", venueId);
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { kind: "failed", venueId, reason: `provider_http_${response.status}` };

    const payload = await response.json() as BestTimeLiveResponse;
    const available = payload.analysis?.venue_live_busyness_available === true;
    const score = payload.analysis?.venue_live_busyness;
    if (payload.status !== "OK" || !available || !validScore(score)) {
      // Crucial: forecast fields returned alongside this payload must never be
      // stored as a live observation.
      return { kind: "unavailable", venueId };
    }
    return { kind: "live", venueId, score: Math.round(score) };
  } catch (error) {
    return {
      kind: "failed",
      venueId,
      reason: error instanceof Error ? error.name : "provider_request_failed",
    };
  }
}

async function inParallel<T, U>(
  values: T[],
  worker: (value: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(PARALLEL_REQUESTS, values.length) }, async () => {
    while (next < values.length) {
      const current = next;
      next += 1;
      results[current] = await worker(values[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const startedAt = Date.now();
  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = requiredEnv("BESTTIME_PRIVATE_API_KEY");
    const authorized =
      request.headers.get("Authorization") === `Bearer ${serviceRoleKey}` ||
      request.headers.get("apikey") === serviceRoleKey;
    if (!authorized) return json({ ok: false, error: "Unauthorized" }, 401);

    const requestedLimit = Number((await request.json().catch(() => ({})) as { limit?: unknown }).limit);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), MAX_VENUES_PER_REFRESH)
      : MAX_VENUES_PER_REFRESH;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase
      .from("venue_mappings")
      .select("besttime_venue_id, live_priority")
      .not("besttime_venue_id", "is", null)
      .order("live_priority", { ascending: false })
      .order("besttime_venue_id")
      .limit(limit);
    if (error) throw new Error(`Venue mapping read failed: ${error.message}`);

    const mappings = (data ?? []) as MappingRow[];
    const outcomes = await inParallel(mappings, (mapping) => fetchLiveVenue(mapping.besttime_venue_id, apiKey));
    const now = new Date();
    const validUntil = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const liveRows = outcomes.filter((outcome): outcome is Extract<RefreshOutcome, { kind: "live" }> => outcome.kind === "live");
    const failureReasons = outcomes
      .filter((outcome): outcome is Extract<RefreshOutcome, { kind: "failed" }> => outcome.kind === "failed")
      .reduce<Record<string, number>>((counts, outcome) => {
        // Keep only a bounded, non-sensitive reason such as provider_http_429.
        // Never persist a response body, URL, or API credential.
        counts[outcome.reason] = (counts[outcome.reason] ?? 0) + 1;
        return counts;
      }, {});

    if (liveRows.length > 0) {
      const { error: cacheError } = await supabase.from("venue_crowd_cache").upsert(
        liveRows.map((outcome) => ({
          besttime_venue_id: outcome.venueId,
          crowd_score: outcome.score,
          activity_level: activityLevel(outcome.score),
          trend: "stable",
          confidence: "high",
          fetched_at: now.toISOString(),
          expires_at: validUntil,
          observation_mode: "live",
        })),
        { onConflict: "besttime_venue_id" },
      );
      if (cacheError) throw new Error(`Crowd cache write failed: ${cacheError.message}`);
    }

    const stats = {
      requested: mappings.length,
      liveWritten: liveRows.length,
      liveUnavailable: outcomes.filter((outcome) => outcome.kind === "unavailable").length,
      providerFailures: outcomes.filter((outcome) => outcome.kind === "failed").length,
      limit,
      durationMs: Date.now() - startedAt,
    };
    const runStatus = stats.providerFailures > 0 ? "partial" : "success";
    const { error: auditError } = await supabase.from("crowd_provider_runs").insert({
      provider: "besttime",
      started_at: new Date(startedAt).toISOString(),
      completed_at: now.toISOString(),
      requested_count: stats.requested,
      live_written_count: stats.liveWritten,
      unavailable_count: stats.liveUnavailable,
      failure_count: stats.providerFailures,
      status: runStatus,
      metadata: { limit: stats.limit, durationMs: stats.durationMs, failureReasons },
    });
    // Observability must never discard a valid live refresh. The next run will
    // retry the audit insert after a transient database failure.
    if (auditError) console.error("BESTTIME RUN AUDIT ERROR", auditError.message);
    console.log("BESTTIME LIVE REFRESH COMPLETATO", stats);
    return json({ ok: true, refreshedAt: now.toISOString(), stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown BestTime refresh error";
    console.error("BESTTIME LIVE REFRESH ERROR", { message });
    return json({ ok: false, error: message, durationMs: Date.now() - startedAt }, 500);
  }
});
