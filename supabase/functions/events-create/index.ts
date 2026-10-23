import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const categories = new Set(["aperitivo", "food", "nightlife", "outdoor", "culture"]);
const MILAN_BOUNDS = { south: 45.35, north: 45.58, west: 8.98, east: 9.35 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function inMilan(latitude: number, longitude: number) {
  return latitude >= MILAN_BOUNDS.south && latitude <= MILAN_BOUNDS.north &&
    longitude >= MILAN_BOUNDS.west && longitude <= MILAN_BOUNDS.east;
}

type CreateEventBody = {
  title?: unknown;
  description?: unknown;
  category?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  expectedAttendance?: unknown;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authHeader = request.headers.get("Authorization");
    const accessToken = authHeader?.replace(/^Bearer\s+/i, "").trim();
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase backend configuration is incomplete");
    if (!accessToken) return json({ ok: false, error: "Authentication required" }, 401);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
    if (userError || !userData.user) return json({ ok: false, error: "Invalid session" }, 401);

    const body = await request.json() as CreateEventBody;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : null;
    const category = typeof body.category === "string" ? body.category : "";
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const expectedAttendance = Math.round(Number(body.expectedAttendance));
    const startAt = new Date(String(body.startAt ?? ""));
    const endAt = new Date(String(body.endAt ?? ""));
    const now = Date.now();

    if (title.length < 3 || title.length > 90) return json({ ok: false, error: "Title must contain 3 to 90 characters" }, 400);
    if (description && description.length > 500) return json({ ok: false, error: "Description is too long" }, 400);
    if (!categories.has(category)) return json({ ok: false, error: "Invalid category" }, 400);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !inMilan(latitude, longitude)) {
      return json({ ok: false, error: "Choose a zone within Milan" }, 400);
    }
    if (!Number.isInteger(expectedAttendance) || expectedAttendance < 2 || expectedAttendance > 5000) {
      return json({ ok: false, error: "Expected attendance must be between 2 and 5000" }, 400);
    }
    if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) ||
      startAt.getTime() < now - 10 * 60 * 1000 || endAt <= startAt ||
      endAt.getTime() > startAt.getTime() + 24 * 60 * 60 * 1000 ||
      startAt.getTime() > now + 30 * 24 * 60 * 60 * 1000) {
      return json({ ok: false, error: "Choose a valid start and end time" }, 400);
    }

    const { count, error: countError } = await supabase
      .from("community_events")
      .select("id", { count: "exact", head: true })
      .eq("created_by", userData.user.id)
      .eq("is_active", true)
      .gte("end_at", new Date(now).toISOString());
    if (countError) throw new Error(countError.message);
    if ((count ?? 0) >= 10) return json({ ok: false, error: "You already have 10 active events" }, 429);

    const { data, error } = await supabase
      .from("community_events")
      .insert({
        created_by: userData.user.id,
        title,
        description: description || null,
        category,
        latitude,
        longitude,
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        expected_attendance: expectedAttendance,
      })
      .select("id, title, description, category, place_id, latitude, longitude, start_at, end_at, expected_attendance, is_active, created_at")
      .single();
    if (error) throw new Error(error.message);

    return json({ ok: true, event: { ...data, source: "community" } }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to publish event";
    console.error("EVENTS CREATE ERROR", { message });
    return json({ ok: false, error: message }, 500);
  }
});
