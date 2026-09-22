import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const categories = new Set(["aperitivo", "food", "nightlife", "outdoor", "culture"]);
type EventWindow = "now" | "today" | "week";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
    },
  });
}

function milanDateParts(date: Date) {
  const values = new Map(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Rome",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

// Converts a Milan wall-clock time to UTC without assuming a fixed CET/CEST
// offset. Two corrections are enough around DST boundaries for these windows.
function milanWallClockToUtc(year: number, month: number, day: number, hour: number): Date {
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  let candidate = new Date(desiredAsUtc);
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const actual = milanDateParts(candidate);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    candidate = new Date(candidate.getTime() + desiredAsUtc - actualAsUtc);
  }
  return candidate;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const url = new URL(request.url);
    const requestedWindow = String(body.window ?? url.searchParams.get("window") ?? "now");
    const window: EventWindow = requestedWindow === "today" || requestedWindow === "week"
      ? requestedWindow
      : "now";
    const requestedCategory = String(body.category ?? url.searchParams.get("category") ?? "all");
    const category = categories.has(requestedCategory) ? requestedCategory : "all";
    const requestedLimit = Number(body.limit ?? url.searchParams.get("limit") ?? 100);
    const limit = Math.min(200, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));
    const now = new Date();

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase backend configuration is incomplete");
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let query = supabase
      .from("events")
      .select("id, title, description, category, venue_name, place_id, address, latitude, longitude, start_at, end_at, source, is_active")
      .eq("is_active", true)
      .gte("end_at", now.toISOString())
      .order("start_at", { ascending: true })
      .limit(limit);

    if (window === "now") {
      query = query.lte("start_at", now.toISOString());
    } else if (window === "today") {
      const local = milanDateParts(now);
      const tomorrowMidnight = milanWallClockToUtc(local.year, local.month, local.day + 1, 0);
      query = query.lt("start_at", tomorrowMidnight.toISOString());
    } else {
      query = query.lt("start_at", new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
    }

    if (category !== "all") query = query.eq("category", category);
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const events = data ?? [];
    console.log("EVENTS READ COMPLETATO", { count: events.length, window, category });
    return jsonResponse({ ok: true, count: events.length, window, category, events });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown events-read error";
    console.error("EVENTS READ ERROR", { message });
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
