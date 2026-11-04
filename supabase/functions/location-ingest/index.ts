import { createClient } from "npm:@supabase/supabase-js@2";
import {
  dailyLocationSessionId,
  locationRevocationDays,
} from "../_shared/location-privacy.ts";

const MILAN_BOUNDS = { south: 45.35, north: 45.58, west: 8.98, east: 9.35 };
const GRID_SIZE = 0.004;
const TELEMETRY_CONSENT_VERSION = "2026-11-private-beta-2";
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
  action?: unknown;
  gridKey?: unknown;
  accuracyMeters?: unknown;
  observedAt?: unknown;
  consentVersion?: unknown;
};
type LastObservation = { observed_at: string };

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
    const sessionHashSalt = Deno.env.get("LOCATION_SESSION_HASH_SALT");
    if (!supabaseUrl || !serviceRoleKey || !sessionHashSalt) {
      throw new Error("Supabase backend configuration is incomplete");
    }

    const authorization = request.headers.get("Authorization") ?? "";
    const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!accessToken) return json({ ok: false, error: "Authentication required" }, 401);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !authData.user) return json({ ok: false, error: "Authenticated beta account required" }, 401);

    const payload = await request.json() as LocationPayload;
    const action = payload.action === "revoke" ? "revoke" : "observe";
    const consentVersion = typeof payload.consentVersion === "string" ? payload.consentVersion : "";
    const nowDate = new Date();

    if (action === "revoke") {
      const sessionIds = await Promise.all(
        locationRevocationDays(nowDate).map((day) =>
          dailyLocationSessionId(authData.user.id, day, sessionHashSalt)
        ),
      );
      const participantUpdate = await supabase
        .from("private_beta_participants")
        .update({ status: "withdrawn", revoked_at: nowDate.toISOString(), updated_at: nowDate.toISOString() })
        .eq("user_id", authData.user.id);
      if (participantUpdate.error) throw new Error(participantUpdate.error.message);
      const purge = await supabase
        .from("location_observations")
        .delete()
        .in("session_id", sessionIds)
        .gte("observed_at", new Date(nowDate.getTime() - 48 * 60 * 60 * 1000).toISOString());
      if (purge.error) throw new Error(purge.error.message);
      return json({ ok: true, revoked: true });
    }

    const gridCell = parseGridKey(payload.gridKey);
    const accuracyMeters = payload.accuracyMeters === null ? null : asFiniteNumber(payload.accuracyMeters);
    const observedAt = typeof payload.observedAt === "string" ? new Date(payload.observedAt) : null;

    if (!gridCell) return json({ ok: false, error: "Invalid privacy grid cell" }, 400);
    if (consentVersion !== TELEMETRY_CONSENT_VERSION) return json({ ok: false, error: "Missing consent" }, 403);
    if (accuracyMeters !== null && (accuracyMeters < 0 || accuracyMeters > MAX_ACCURACY_METERS)) {
      return json({ ok: false, error: "Location accuracy is insufficient" }, 400);
    }
    if (!observedAt || Number.isNaN(observedAt.getTime())) return json({ ok: false, error: "Invalid observation time" }, 400);

    const now = nowDate.getTime();
    if (observedAt.getTime() < now - MAX_OBSERVATION_AGE_MS || observedAt.getTime() > now + MAX_FUTURE_SKEW_MS) {
      return json({ ok: false, error: "Observation time is outside the accepted window" }, 400);
    }

    const sessionId = await dailyLocationSessionId(authData.user.id, observedAt, sessionHashSalt);
    const existingParticipant = await supabase
      .from("private_beta_participants")
      .select("status, consent_version, consented_at")
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (existingParticipant.error) throw new Error(existingParticipant.error.message);
    const existingConsentTime = existingParticipant.data?.consented_at;
    const keepExistingConsentTime =
      existingParticipant.data?.status === "active" &&
      existingParticipant.data.consent_version === consentVersion &&
      typeof existingConsentTime === "string";
    const participant = await supabase.from("private_beta_participants").upsert({
      user_id: authData.user.id,
      status: "active",
      consent_version: consentVersion,
      consented_at: keepExistingConsentTime
        ? existingConsentTime
        : nowDate.toISOString(),
      revoked_at: null,
      updated_at: nowDate.toISOString(),
    }, { onConflict: "user_id" });
    if (participant.error) throw new Error(participant.error.message);

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

    const participantTouch = await supabase
      .from("private_beta_participants")
      .update({ last_contribution_at: nowDate.toISOString(), updated_at: nowDate.toISOString() })
      .eq("user_id", authData.user.id);
    if (participantTouch.error) throw new Error(participantTouch.error.message);

    return json({ ok: true, accepted: true });
  } catch (error) {
    // Never log payloads: latitude/longitude are personal data before aggregation.
    console.error("LOCATION INGEST ERROR", error instanceof Error ? error.message : "Unknown error");
    return json({ ok: false, error: "Unable to record location observation" }, 500);
  }
});
