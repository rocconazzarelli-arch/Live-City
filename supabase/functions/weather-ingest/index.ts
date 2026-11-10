import { createClient } from "npm:@supabase/supabase-js@2";

import {
  buildArchiveUrl,
  buildForecastUrl,
  MILAN_WEATHER_LOCATION,
  type OpenMeteoResponse,
  parseHourlyWeather,
  validateBackfillRange,
  type WeatherRow,
} from "../_shared/weather.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UPSERT_CHUNK_SIZE = 1000;

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

async function fetchOpenMeteo(url: string): Promise<OpenMeteoResponse> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Open-Meteo responded ${response.status}: ${detail.slice(0, 200)}`);
  }
  return await response.json() as OpenMeteoResponse;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405);

  const startedAt = Date.now();

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const serviceRoleAuthorized =
      request.headers.get("Authorization") === `Bearer ${serviceRoleKey}` ||
      request.headers.get("apikey") === serviceRoleKey;
    if (!serviceRoleAuthorized) {
      return jsonResponse({ ok: false, error: "Unauthorized weather ingest request" }, 401);
    }

    const body = await request.json().catch(() => ({})) as {
      mode?: string;
      startDate?: string;
      endDate?: string;
    };
    const mode = body.mode ?? "recent";
    if (mode !== "recent" && mode !== "backfill") {
      return jsonResponse({ ok: false, error: "mode must be 'recent' or 'backfill'" }, 400);
    }

    // The free Open-Meteo API is for non-commercial use; a commercial plan key
    // switches to the customer hosts without code changes.
    const apiKey = Deno.env.get("OPEN_METEO_API_KEY") || undefined;
    const now = new Date();
    let rows: WeatherRow[];

    if (mode === "backfill") {
      const range = validateBackfillRange(body.startDate, body.endDate, now);
      if (!range.ok) return jsonResponse({ ok: false, error: range.error }, 400);
      const payload = await fetchOpenMeteo(
        buildArchiveUrl(MILAN_WEATHER_LOCATION, range.startDate, range.endDate, apiKey),
      );
      rows = parseHourlyWeather(payload, MILAN_WEATHER_LOCATION, "archive", now);
    } else {
      const payload = await fetchOpenMeteo(buildForecastUrl(MILAN_WEATHER_LOCATION, apiKey));
      rows = parseHourlyWeather(payload, MILAN_WEATHER_LOCATION, "forecast", now);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // The RPC keeps the most authoritative value per hour: a forecast never
    // overwrites analysis, and nothing overwrites reanalysis.
    let rowsWritten = 0;
    for (let index = 0; index < rows.length; index += UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(index, index + UPSERT_CHUNK_SIZE);
      const { data, error } = await supabase.rpc("upsert_weather_observations", { p_rows: chunk });
      if (error) throw new Error(`Weather upsert failed: ${error.message}`);
      rowsWritten += Number(data ?? 0);
    }

    const stats = {
      mode,
      locationKey: MILAN_WEATHER_LOCATION.key,
      rowsParsed: rows.length,
      rowsWritten,
      rowsKeptExisting: rows.length - rowsWritten,
      firstHour: rows[0]?.observed_at ?? null,
      lastHour: rows.at(-1)?.observed_at ?? null,
      kinds: rows.reduce<Record<string, number>>((counts, row) => {
        counts[row.data_kind] = (counts[row.data_kind] ?? 0) + 1;
        return counts;
      }, {}),
      durationMs: Date.now() - startedAt,
    };

    console.log("WEATHER INGEST COMPLETATO", stats);
    return jsonResponse({ ok: true, stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown weather ingest error";
    console.error("WEATHER INGEST ERROR", { message });
    return jsonResponse({ ok: false, error: message, durationMs: Date.now() - startedAt }, 500);
  }
});
