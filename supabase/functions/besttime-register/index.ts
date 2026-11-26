// One-off helper for the Porta Venezia test: registers venues on BestTime
// (New Forecast) using the private key held in Supabase secrets, so the key
// never leaves the server. Each successful call costs BestTime credits, so the
// caller passes an explicit, small list. Returns the venue_id and the venue
// BestTime actually matched, so a wrong match can be caught before it is used.

import { BESTTIME_KEYS_URL, BESTTIME_NEW_FORECAST_URL } from "../_shared/besttime.ts";

const REQUEST_TIMEOUT_MS = 25_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-refresh-secret",
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

type VenueInput = { name?: unknown; address?: unknown };

type RegisterRequest = {
  action?: unknown;
  confirmedMaxCredits?: unknown;
  venues?: VenueInput[];
};

type BestTimeKeyResponse = {
  active?: unknown;
  status?: unknown;
  valid?: unknown;
};

type BestTimeForecastResponse = {
  status?: string;
  message?: string;
  venue_info?: {
    venue_id?: string;
    venue_name?: string;
    venue_address?: string;
    venue_lat?: number;
    venue_lng?: number;
    venue_lon?: number;
  };
};

async function registerVenue(name: string, address: string, apiKey: string) {
  try {
    const url = new URL(BESTTIME_NEW_FORECAST_URL);
    url.searchParams.set("api_key_private", apiKey);
    url.searchParams.set("venue_name", name);
    url.searchParams.set("venue_address", address);
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({})) as BestTimeForecastResponse;
    const info = payload.venue_info ?? {};
    return {
      input_name: name,
      status: payload.status ?? `http_${response.status}`,
      message: payload.message ?? null,
      venue_id: info.venue_id ?? null,
      matched_name: info.venue_name ?? null,
      matched_address: info.venue_address ?? null,
      lat: typeof info.venue_lat === "number" ? info.venue_lat : null,
      lng: typeof info.venue_lon === "number"
        ? info.venue_lon
        : typeof info.venue_lng === "number"
        ? info.venue_lng
        : null,
    };
  } catch (error) {
    return {
      input_name: name,
      status: "error",
      message: error instanceof Error ? error.name : "request_failed",
      venue_id: null,
      matched_name: null,
      matched_address: null,
      lat: null,
      lng: null,
    };
  }
}

async function validateKey(apiKey: string): Promise<Response> {
  try {
    // The key endpoint is an authentication preflight, not a forecast/live
    // endpoint. Never include the provider payload because it echoes both keys.
    const response = await fetch(`${BESTTIME_KEYS_URL}/${encodeURIComponent(apiKey)}`, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({})) as BestTimeKeyResponse;
    const valid = response.ok && payload.status === "OK" && payload.valid === true;
    const active = valid && payload.active === true;
    return json({
      ok: valid && active,
      valid,
      active,
      status: typeof payload.status === "string" ? payload.status : `http_${response.status}`,
    }, valid && active ? 200 : 422);
  } catch (error) {
    return json({
      ok: false,
      valid: false,
      active: false,
      status: error instanceof Error ? error.name : "request_failed",
    }, 502);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const expectedSecret = requiredEnv("CROWD_PIPELINE_SECRET");
    if (request.headers.get("x-refresh-secret") !== expectedSecret) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    const apiKey = requiredEnv("BESTTIME_PRIVATE_API_KEY");
    const body = await request.json().catch(() => ({})) as RegisterRequest;
    if (body.action === "validate-key") return await validateKey(apiKey);

    const venues = Array.isArray(body.venues) ? body.venues : [];
    if (body.action !== "register-venues") {
      return json({ ok: false, error: "Explicit action register-venues is required" }, 400);
    }
    if (venues.length === 0 || venues.length > 8) {
      return json({ ok: false, error: "Provide between 1 and 8 venues per call" }, 400);
    }
    const maximumCredits = venues.length * 2;
    if (body.confirmedMaxCredits !== maximumCredits) {
      return json({
        ok: false,
        error: `Set confirmedMaxCredits=${maximumCredits} to acknowledge the maximum provider spend`,
      }, 409);
    }

    // Sequential, to respect provider rate limits and keep credit spend legible.
    const results = [];
    for (const venue of venues) {
      const name = String(venue.name ?? "").trim();
      const address = String(venue.address ?? "").trim();
      if (!name || !address) {
        results.push({
          input_name: name || "(empty)",
          status: "skipped_missing_field",
          message: "name and address are required",
          venue_id: null,
          matched_name: null,
          matched_address: null,
          lat: null,
          lng: null,
        });
        continue;
      }
      results.push(await registerVenue(name, address, apiKey));
    }

    const registered = results.filter((r) => r.venue_id).length;
    const complete = registered === results.length;
    return json({ ok: complete, registered, total: results.length, maximumCredits, results }, complete ? 200 : 207);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({ ok: false, error: message }, 500);
  }
});
