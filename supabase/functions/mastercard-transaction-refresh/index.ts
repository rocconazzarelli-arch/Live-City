import { createClient } from "npm:@supabase/supabase-js@2";

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
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const startedAt = Date.now();
  try {
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const configuredRefreshSecret = Deno.env.get("CROWD_ENGINE_REFRESH_SECRET");
    const serviceRoleAuthorized =
      request.headers.get("Authorization") === `Bearer ${serviceRoleKey}` ||
      request.headers.get("apikey") === serviceRoleKey;
    const refreshSecretAuthorized = Boolean(
      configuredRefreshSecret && request.headers.get("x-refresh-secret") === configuredRefreshSecret,
    );
    if (!serviceRoleAuthorized && !refreshSecretAuthorized) {
      return json({ ok: false, error: "Unauthorized refresh request" }, 401);
    }

    const supabase = createClient(requiredEnv("SUPABASE_URL"), serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.rpc("refresh_mastercard_transaction_snapshots");
    if (error) throw new Error(`Mastercard aggregate refresh failed: ${error.message}`);

    return json({ ok: true, aggregate: data, durationMs: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Mastercard aggregate error";
    console.error("MASTERCARD AGGREGATE ERROR", { message });
    return json({ ok: false, error: message, durationMs: Date.now() - startedAt }, 500);
  }
});
