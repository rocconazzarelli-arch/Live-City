import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const categories = new Set(["aperitivo", "food", "nightlife", "outdoor", "culture"]);
type EventWindow = "now" | "today" | "week";

type CommunityEvent = {
  id: string;
  title: string;
  description: string | null;
  category: string;
  place_id: number | null;
  latitude: number;
  longitude: number;
  start_at: string;
  end_at: string;
  expected_attendance: number;
  is_active: boolean;
};

function plannedCrowdScore(event: CommunityEvent, now: Date): number {
  const startAt = new Date(event.start_at).getTime();
  const endAt = new Date(event.end_at).getTime();
  const lookAheadMs = 4 * 60 * 60 * 1000;
  const attendanceScore = Math.min(88, Math.round(12 + 15 * Math.log2(1 + event.expected_attendance / 10)));
  if (startAt <= now.getTime() && endAt >= now.getTime()) return attendanceScore;
  const proximity = Math.max(0, 1 - (startAt - now.getTime()) / lookAheadMs);
  return Math.round(attendanceScore * (0.3 + 0.7 * proximity));
}

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

    let editorialQuery = supabase
      .from("events")
      .select("id, title, description, category, venue_name, place_id, address, latitude, longitude, start_at, end_at, source, is_active")
      .eq("is_active", true)
      .gte("end_at", now.toISOString())
      .order("start_at", { ascending: true })
      .limit(limit);

    let communityQuery = supabase
      .from("community_events")
      .select("id, title, description, category, place_id, latitude, longitude, start_at, end_at, expected_attendance, is_active")
      .eq("is_active", true)
      .gte("end_at", now.toISOString())
      .order("start_at", { ascending: true })
      .limit(limit);

    if (window === "now") {
      editorialQuery = editorialQuery.lte("start_at", now.toISOString());
      communityQuery = communityQuery.lte("start_at", now.toISOString());
    } else if (window === "today") {
      const local = milanDateParts(now);
      const tomorrowMidnight = milanWallClockToUtc(local.year, local.month, local.day + 1, 0);
      editorialQuery = editorialQuery.lt("start_at", tomorrowMidnight.toISOString());
      communityQuery = communityQuery.lt("start_at", tomorrowMidnight.toISOString());
    } else {
      const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      editorialQuery = editorialQuery.lt("start_at", weekEnd);
      communityQuery = communityQuery.lt("start_at", weekEnd);
    }

    if (category !== "all") {
      editorialQuery = editorialQuery.eq("category", category);
      communityQuery = communityQuery.eq("category", category);
    }
    const [editorialResult, communityResult] = await Promise.all([editorialQuery, communityQuery]);
    if (editorialResult.error ?? communityResult.error) {
      throw new Error((editorialResult.error ?? communityResult.error)?.message);
    }

    const editorialEvents = editorialResult.data ?? [];
    const communityEvents = (communityResult.data ?? []) as CommunityEvent[];
    const events = [
      ...editorialEvents,
      ...communityEvents.map((event) => ({
        ...event,
        venue_name: null,
        address: "Zona scelta dall'organizzatore",
        source: "community",
        crowd_forecast_score: plannedCrowdScore(event, now),
      })),
    ].sort((left, right) => new Date(left.start_at).getTime() - new Date(right.start_at).getTime()).slice(0, limit);
    console.log("EVENTS READ COMPLETATO", { count: events.length, window, category });
    return jsonResponse({ ok: true, count: events.length, window, category, events });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown events-read error";
    console.error("EVENTS READ ERROR", { message });
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
