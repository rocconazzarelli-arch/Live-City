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

async function callFunction(
  baseUrl: string,
  serviceRoleKey: string,
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const response = await fetch(`${baseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  let responseBody: unknown = text;
  try {
    responseBody = JSON.parse(text);
  } catch {
    // Preserve a non-JSON provider response for diagnostics.
  }
  return { status: response.status, ok: response.ok, body: responseBody };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const startedAt = Date.now();
  try {
    const expectedSecret = requiredEnv("CROWD_PIPELINE_SECRET");
    if (request.headers.get("x-refresh-secret") !== expectedSecret) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    const baseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const body = await request.json().catch(() => ({})) as {
      forceProvider?: boolean;
      forceWeather?: boolean;
    };
    // The pipeline itself runs every 20 minutes, while BestTime live data is
    // refreshed only once per clock hour. A signed manual caller may force it.
    const firstRunOfHour = new Date().getUTCMinutes() < 5;
    const providerRefreshDue = body.forceProvider === true || firstRunOfHour;
    // Open-Meteo data is hourly, so one weather refresh per hour is enough.
    const weatherRefreshDue = body.forceWeather === true || firstRunOfHour;
    const providerPromise = providerRefreshDue
      ? callFunction(baseUrl, serviceRoleKey, "crowd-refresh", {
          dryRun: false,
          // Product capacity policy: keep live-provider coverage focused on the
          // highest-priority venues and never exceed 100 in one refresh cycle.
          limit: 100,
        })
      : Promise.resolve({
          status: 204,
          ok: true,
          body: { skipped: true, reason: "BestTime refresh is hourly" },
        });
    const weatherPromise = weatherRefreshDue
      ? callFunction(baseUrl, serviceRoleKey, "weather-ingest", { mode: "recent" })
      : Promise.resolve({
          status: 204,
          ok: true,
          body: { skipped: true, reason: "Weather refresh is hourly" },
        });
    const [provider, telemetry, mastercard, weather] = await Promise.all([
      providerPromise,
      // Aggregate the coarse privacy cells immediately before recalculating
      // estimates. This replaces the old, non-existent `crowd-aggregate`
      // dependency and makes the 20-minute pipeline deterministic: only
      // k-anonymous area snapshots can reach the crowd engine.
      callFunction(baseUrl, serviceRoleKey, "area-heatmap-refresh", {}),
      // Mastercard Transaction Notifications are first reduced to a
      // k-anonymous per-venue count. Raw payment events never reach the crowd
      // engine and this adapter remains optional when no production feed is
      // configured.
      callFunction(baseUrl, serviceRoleKey, "mastercard-transaction-refresh", {}),
      // A network or quota failure must not reject the whole batch.
      weatherPromise.catch((error) => ({
        status: 502,
        ok: false,
        body: { error: error instanceof Error ? error.message : "Weather ingest failed" },
      })),
    ]);

    // Provider, transaction-proxy, telemetry or weather failures must never
    // stop the estimate refresh; the engine can continue from the remaining
    // signals.
    const engine = await callFunction(baseUrl, serviceRoleKey, "crowd-engine-refresh", {});
    const status = engine.ok ? 200 : 502;
    return json({
      ok: engine.ok,
      provider,
      telemetry,
      mastercard,
      weather,
      engine,
      durationMs: Date.now() - startedAt,
    }, status);
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown pipeline error",
      durationMs: Date.now() - startedAt,
    }, 500);
  }
});
