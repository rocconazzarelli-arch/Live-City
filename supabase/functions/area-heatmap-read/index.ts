import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
    },
  });
}

type AreaSnapshot = {
  grid_key: string;
  center_latitude: number;
  center_longitude: number;
  window_end: string;
  distinct_sessions: number;
  density_score: number;
};

type CommunityEvent = {
  id: string;
  latitude: number;
  longitude: number;
  start_at: string;
  end_at: string;
  expected_attendance: number;
};

type MobilityCell = {
  grid_key: string;
  center_latitude: number;
  center_longitude: number;
  service_intensity: number;
  mobility_score: number;
  stop_count: number;
  source_updated_at: string;
};

const GRID_SIZE = 0.004;
const EVENT_LOOKAHEAD_MS = 4 * 60 * 60 * 1000;

function eventForecastScore(event: CommunityEvent, now: Date) {
  const startAt = new Date(event.start_at).getTime();
  const endAt = new Date(event.end_at).getTime();
  const attendanceScore = Math.min(88, Math.round(12 + 15 * Math.log2(1 + event.expected_attendance / 10)));
  if (startAt <= now.getTime() && endAt >= now.getTime()) return attendanceScore;
  const proximity = Math.max(0, 1 - (startAt - now.getTime()) / EVENT_LOOKAHEAD_MS);
  return Math.round(attendanceScore * (0.3 + 0.7 * proximity));
}

function romeMobilitySlot(now: Date): { dayType: "L" | "S" | "F"; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  return {
    dayType: weekday === "Sat" ? "S" : weekday === "Sun" ? "F" : "L",
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0),
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const strategy = new URL(request.url).searchParams.get("strategy") === "hybrid"
      ? "hybrid"
      : "besttime";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase backend configuration is incomplete");

    const cutoff = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const eventWindowEnd = new Date(Date.now() + EVENT_LOOKAHEAD_MS).toISOString();
    const mobilitySlot = romeMobilitySlot(new Date());
    const [result, eventsResult, mobilityResult] = await Promise.all([
      supabase
      .from("crowd_area_snapshots")
      .select("grid_key, center_latitude, center_longitude, window_end, distinct_sessions, density_score")
      .gte("window_end", cutoff)
      .gte("distinct_sessions", 5)
      .order("window_end", { ascending: false })
      .limit(250),
      supabase
        .from("community_events")
        .select("id, latitude, longitude, start_at, end_at, expected_attendance")
        .eq("is_active", true)
        .gte("end_at", new Date().toISOString())
        .lte("start_at", eventWindowEnd)
        .limit(100),
      strategy === "hybrid"
        ? supabase
          .from("mobility_cell_profiles")
          .select("grid_key, center_latitude, center_longitude, service_intensity, mobility_score, stop_count, source_updated_at")
          .eq("local_day_type", mobilitySlot.dayType)
          .eq("local_hour", mobilitySlot.hour)
          .order("mobility_score", { ascending: false })
          .limit(350)
        : Promise.resolve({ data: [] as MobilityCell[], error: null }),
    ]);
    const readError = result.error ?? eventsResult.error ?? mobilityResult.error;
    if (readError) throw new Error(readError.message);

    const latestByGrid = new Map<string, AreaSnapshot>();
    for (const row of (result.data ?? []) as AreaSnapshot[]) {
      if (!latestByGrid.has(row.grid_key)) latestByGrid.set(row.grid_key, row);
    }

    const cells = [...latestByGrid.values()].map((row) => ({
      id: row.grid_key,
      latitude: row.center_latitude,
      longitude: row.center_longitude,
      score: row.density_score,
      radius: 360,
      distinctSessions: row.distinct_sessions,
      observedAt: row.window_end,
    }));
    const plannedByGrid = new Map<string, { latitude: number; longitude: number; score: number; eventCount: number; expectedAttendance: number }>();
    for (const event of (eventsResult.data ?? []) as CommunityEvent[]) {
      const key = `${Math.floor(event.latitude / GRID_SIZE)}:${Math.floor(event.longitude / GRID_SIZE)}`;
      const existing = plannedByGrid.get(key);
      const score = eventForecastScore(event, new Date());
      plannedByGrid.set(key, {
        latitude: (Math.floor(event.latitude / GRID_SIZE) + 0.5) * GRID_SIZE,
        longitude: (Math.floor(event.longitude / GRID_SIZE) + 0.5) * GRID_SIZE,
        score: Math.min(100, (existing?.score ?? 0) + score),
        eventCount: (existing?.eventCount ?? 0) + 1,
        expectedAttendance: (existing?.expectedAttendance ?? 0) + event.expected_attendance,
      });
    }
    const eventForecastCells = [...plannedByGrid.entries()].map(([id, cell]) => ({
      id: `event:${id}`,
      ...cell,
      radius: 360,
      source: "declared_event_forecast",
    }));
    const mobilityForecastCells = ((mobilityResult.data ?? []) as MobilityCell[]).map((cell) => ({
      id: `mobility:${cell.grid_key}`,
      latitude: cell.center_latitude,
      longitude: cell.center_longitude,
      score: cell.mobility_score,
      radius: 320,
      serviceIntensity: cell.service_intensity,
      stopCount: cell.stop_count,
      sourceUpdatedAt: cell.source_updated_at,
      source: "comune_milano_scheduled_mobility",
      dataClass: "forecast_proxy",
    }));
    return json({
      success: true,
      strategy,
      cells,
      eventForecastCells,
      mobilityForecastCells,
      privacyThreshold: 5,
    });
  } catch (error) {
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});
