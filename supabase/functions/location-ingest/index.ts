import { createClient } from "npm:@supabase/supabase-js@2";

const MILAN_BOUNDS = { south: 45.35, north: 45.58, west: 8.98, east: 9.35 };
const GRID_SIZE = 0.004;
const TELEMETRY_CONSENT_VERSION = "2026-10-private-beta-1";
const MAX_ACCURACY_METERS = 250;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_OBSERVATION_AGE_MS = 20 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

type LocationPayload = {
  sessionId?: unknown;
  gridKey?: unknown;
  accuracyMeters?: unknown;
  observedAt?: unknown;
  consentVersion?: unknown;
};
type LastObservation = { observed_at: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isInsideMilan(latitude: number, longitude: number): boolean {
  return latitude >= MILAN_BOUNDS.south && latitude <= MILAN_BOUNDS.north
    && longitude >= MILAN_BOUNDS.west && longitude <= MILAN_BOUNDS.east;
}

function parseGridKey(value: unknown): { gridLat: number; gridLng: number; latitude: number; longitude: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(-?\d+):(-?\d+)$/.exec(value);
  if (!match) return null;
  const gridLat = Number(match[1]);
  const gridLng = Number(match[2]);
  if (!Number.isSafeInteger(gridLat) || !Number.isSafeInteger(gridLng)) return null;
  const latitude = (gridLat + 0.5) * GRID_SIZE;
  const longitude = (gridLng + 0.5) * GRID_SIZE;
  return isInsideMilan(latitude, longitude) ? { gridLat, gridLng, latitude, longitude } : null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase backend configuration is incomplete");

    const payload = await request.json() as LocationPayload;
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const gridCell = parseGridKey(payload.gridKey);
    const accuracyMeters = payload.accuracyMeters === null ? null : asFiniteNumber(payload.accuracyMeters);
    const observedAt = typeof payload.observedAt === "string" ? new Date(payload.observedAt) : null;
    const consentVersion = typeof payload.consentVersion === "string" ? payload.consentVersion : "";

    if (!UUID_PATTERN.test(sessionId)) return json({ ok: false, error: "Invalid session" }, 400);
    if (!gridCell) return json({ ok: false, error: "Invalid privacy grid cell" }, 400);
    if (consentVersion !== TELEMETRY_CONSENT_VERSION) return json({ ok: false, error: "Missing consent" }, 403);
    if (accuracyMeters !== null && (accuracyMeters < 0 || accuracyMeters > MAX_ACCURACY_METERS)) {
      return json({ ok: false, error: "Location accuracy is insufficient" }, 400);
    }
    if (!observedAt || Number.isNaN(observedAt.getTime())) return json({ ok: false, error: "Invalid observation time" }, 400);

    const now = Date.now();
    if (observedAt.getTime() < now - MAX_OBSERVATION_AGE_MS || observedAt.getTime() > now + MAX_FUTURE_SKEW_MS) {
      return json({ ok: false, error: "Observation time is outside the accepted window" }, 400);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const previous = await supabase
      .from("location_observations")
      .select("observed_at")
      .eq("session_id", sessionId)
      .order("observed_at", { ascending: false })
      .limit(1)
      .maybeSingle<LastObservation>();
    if (previous.error) throw new Error(previous.error.message);

    if (previous.data && now - new Date(previous.data.observed_at).getTime() < MIN_INTERVAL_MS) {
      return json({ ok: true, accepted: false, reason: "rate_limited" }, 202);
    }

    const insert = await supabase.from("location_observations").insert({
      session_id: sessionId,
      // The precise device fix never crosses the network boundary. The stored
      // coordinates are the canonical centre of the coarse privacy cell.
      latitude: gridCell.latitude,
      longitude: gridCell.longitude,
      grid_lat: gridCell.gridLat,
      grid_lng: gridCell.gridLng,
      accuracy_meters: accuracyMeters,
      observed_at: observedAt.toISOString(),
      consent_version: consentVersion,
    });
    if (insert.error) {
      if (insert.error.code === "23505") return json({ ok: true, accepted: false, reason: "duplicate" }, 202);
      throw new Error(insert.error.message);
    }

    return json({ ok: true, accepted: true });
  } catch (error) {
    // Never log payloads: latitude/longitude are personal data before aggregation.
    console.error("LOCATION INGEST ERROR", error instanceof Error ? error.message : "Unknown error");
    return json({ ok: false, error: "Unable to record location observation" }, 500);
  }
});
