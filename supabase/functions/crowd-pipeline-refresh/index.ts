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
    const body = await request.json().catch(() => ({})) as { forceProvider?: boolean };
    // The pipeline itself runs every 20 minutes, while BestTime live data is
    // refreshed only once per clock hour. A signed manual caller may force it.
    const providerRefreshDue = body.forceProvider === true || new Date().getUTCMinutes() < 5;
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
    const [provider, telemetry] = await Promise.all([
      providerPromise,
      // Aggregate the coarse privacy cells immediately before recalculating
      // estimates. This replaces the old, non-existent `crowd-aggregate`
      // dependency and makes the 20-minute pipeline deterministic: only
      // k-anonymous area snapshots can reach the crowd engine.
      callFunction(baseUrl, serviceRoleKey, "area-heatmap-refresh", {}),
    ]);

    // Provider or telemetry failures must never stop the hybrid estimate refresh.
    const engine = await callFunction(baseUrl, serviceRoleKey, "crowd-engine-refresh", {});
    const status = engine.ok ? 200 : 502;
    return json({
      ok: engine.ok,
      provider,
      telemetry,
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
