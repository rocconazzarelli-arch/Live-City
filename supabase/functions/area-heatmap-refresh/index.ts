import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase backend configuration is incomplete");

    const authorized =
      request.headers.get("Authorization") === `Bearer ${serviceRoleKey}` ||
      request.headers.get("apikey") === serviceRoleKey;
    if (!authorized) return json({ ok: false, error: "Unauthorized" }, 401);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.rpc("refresh_crowd_area_snapshots");
    if (error) throw new Error(error.message);

    return json({ ok: true, aggregate: data });
  } catch (error) {
    console.error("AREA HEATMAP REFRESH ERROR", error instanceof Error ? error.message : "Unknown error");
    return json({ ok: false, error: "Unable to refresh private area aggregates" }, 500);
  }
});
