import { createClient } from "npm:@supabase/supabase-js@2";
import {
  BESTTIME_LIVE_URL,
  classifyBestTimeLivePayload,
} from "../_shared/besttime.ts";
import {
  isLiveAvailabilityEligible,
  isLiveReadDueAt,
  normalizeLiveReadHours,
  romeHour,
} from "../_shared/live-schedule.ts";

const MAX_VENUES_PER_REFRESH = 100;
// Upper bound on mapping rows scanned before the per-venue window filter.
const MAX_MAPPINGS_SCANNED = 1000;
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
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
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
  live_read_hours: unknown;
  live_read_from: unknown;
  live_read_until: unknown;
  live_availability_status: unknown;
};

type RefreshOutcome =
  | { kind: "live"; venueId: string; score: number }
  | { kind: "unavailable"; venueId: string }
  | { kind: "failed"; venueId: string; reason: string };

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
    if (!response.ok) {
      return {
        kind: "failed",
        venueId,
        reason: `provider_http_${response.status}`,
      };
    }

    const classification = classifyBestTimeLivePayload(await response.json());
    if (classification.kind === "failed") {
      // A key, quota, or provider-wide error must not suspend every venue.
      return { kind: "failed", venueId, reason: classification.reason };
    }
    if (classification.kind === "unavailable") {
      // Crucial: forecast fields returned alongside this payload must never be
      // stored as a live observation. This explicit per-venue outcome also
      // suspends later paid reads until a manual reset.
      return { kind: "unavailable", venueId };
    }
    return { kind: "live", venueId, score: classification.score };
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
  const workers = Array.from({
    length: Math.min(PARALLEL_REQUESTS, values.length),
  }, async () => {
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
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const startedAt = Date.now();
  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = requiredEnv("BESTTIME_PRIVATE_API_KEY");
    const authorized =
      request.headers.get("Authorization") === `Bearer ${serviceRoleKey}` ||
      request.headers.get("apikey") === serviceRoleKey;
    if (!authorized) return json({ ok: false, error: "Unauthorized" }, 401);

    const requestedLimit = Number(
      (await request.json().catch(() => ({})) as { limit?: unknown }).limit,
    );
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), MAX_VENUES_PER_REFRESH)
      : MAX_VENUES_PER_REFRESH;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase
      .from("venue_mappings")
      .select(
        "besttime_venue_id, live_priority, live_read_hours, live_read_from, live_read_until, live_availability_status",
      )
      .not("besttime_venue_id", "is", null)
      .order("live_priority", { ascending: false })
      .order("besttime_venue_id")
      .limit(MAX_MAPPINGS_SCANNED);
    if (error) throw new Error(`Venue mapping read failed: ${error.message}`);

    // Only venues whose read window contains the current Rome hour are
    // queried: every BestTime Live call is billed, even for a closed venue.
    const currentInstant = new Date(startedAt);
    const currentHour = romeHour(currentInstant);
    const allMappings = (data ?? []) as MappingRow[];
    const eligibleMappings = allMappings.filter((mapping) =>
      isLiveAvailabilityEligible(mapping.live_availability_status)
    );
    const dueMappings = eligibleMappings.filter((mapping) =>
      isLiveReadDueAt(
        normalizeLiveReadHours(mapping.live_read_hours),
        currentInstant,
        mapping.live_read_from,
        mapping.live_read_until,
      )
    );
    const mappings = dueMappings.slice(0, limit);
    const scheduledSkipped = eligibleMappings.length - dueMappings.length;
    const suspendedSkipped = allMappings.length - eligibleMappings.length;
    const outcomes = await inParallel(
      mappings,
      (mapping) => fetchLiveVenue(mapping.besttime_venue_id, apiKey),
    );
    const now = new Date();
    const validUntil = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const liveRows = outcomes.filter((
      outcome,
    ): outcome is Extract<RefreshOutcome, { kind: "live" }> =>
      outcome.kind === "live"
    );
    const unavailableRows = outcomes.filter(
      (outcome): outcome is Extract<RefreshOutcome, { kind: "unavailable" }> =>
        outcome.kind === "unavailable",
    );
    const failureReasons = outcomes
      .filter((
        outcome,
      ): outcome is Extract<RefreshOutcome, { kind: "failed" }> =>
        outcome.kind === "failed"
      )
      .reduce<Record<string, number>>((counts, outcome) => {
        // Keep only a bounded, non-sensitive reason such as provider_http_429.
        // Never persist a response body, URL, or API credential.
        counts[outcome.reason] = (counts[outcome.reason] ?? 0) + 1;
        return counts;
      }, {});

    if (unavailableRows.length > 0) {
      const { error: suspensionError } = await supabase
        .from("venue_mappings")
        .update({
          live_availability_status: "suspended",
          live_suspended_at: now.toISOString(),
          live_suspension_reason: "provider_live_unavailable",
          updated_at: now.toISOString(),
        })
        .in(
          "besttime_venue_id",
          unavailableRows.map((outcome) => outcome.venueId),
        );
      if (suspensionError) {
        // Failing this write would allow the same venue to spend another credit
        // on the next run, so the refresh must fail closed.
        throw new Error(
          `Venue suspension write failed: ${suspensionError.message}`,
        );
      }
    }

    if (liveRows.length > 0) {
      const { error: confirmationError } = await supabase
        .from("venue_mappings")
        .update({
          live_availability_status: "confirmed",
          live_suspended_at: null,
          live_suspension_reason: null,
          updated_at: now.toISOString(),
        })
        .in("besttime_venue_id", liveRows.map((outcome) => outcome.venueId));
      if (confirmationError) {
        throw new Error(
          `Venue live confirmation failed: ${confirmationError.message}`,
        );
      }
    }

    if (liveRows.length > 0) {
      const { error: cacheError } = await supabase.from("venue_crowd_cache")
        .upsert(
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
      if (cacheError) {
        throw new Error(`Crowd cache write failed: ${cacheError.message}`);
      }
    }

    const stats = {
      requested: mappings.length,
      liveWritten: liveRows.length,
      liveUnavailable: outcomes.filter((outcome) =>
        outcome.kind === "unavailable"
      ).length,
      providerFailures: outcomes.filter((outcome) =>
        outcome.kind === "failed"
      ).length,
      scheduledSkipped,
      suspendedNow: unavailableRows.length,
      suspendedSkipped,
      romeHour: currentHour,
      limit,
      durationMs: Date.now() - startedAt,
    };
    const runStatus = stats.providerFailures > 0 ? "partial" : "success";
    const { error: auditError } = await supabase.from("crowd_provider_runs")
      .insert({
        provider: "besttime",
        started_at: new Date(startedAt).toISOString(),
        completed_at: now.toISOString(),
        requested_count: stats.requested,
        live_written_count: stats.liveWritten,
        unavailable_count: stats.liveUnavailable,
        failure_count: stats.providerFailures,
        status: runStatus,
        metadata: {
          limit: stats.limit,
          durationMs: stats.durationMs,
          failureReasons,
          scheduledSkipped: stats.scheduledSkipped,
          suspendedNow: stats.suspendedNow,
          suspendedSkipped: stats.suspendedSkipped,
          romeHour: stats.romeHour,
        },
      });
    // Observability must never discard a valid live refresh. The next run will
    // retry the audit insert after a transient database failure.
    if (auditError) {
      console.error("BESTTIME RUN AUDIT ERROR", auditError.message);
    }
    console.log("BESTTIME LIVE REFRESH COMPLETATO", stats);
    return json({ ok: true, refreshedAt: now.toISOString(), stats });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Unknown BestTime refresh error";
    console.error("BESTTIME LIVE REFRESH ERROR", { message });
    return json({
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
    }, 500);
  }
});
