export type PlaceCategory =
  | "aperitivo"
  | "food"
  | "nightlife"
  | "outdoor"
  | "culture";

export type ActivityLevel = "low" | "medium" | "high" | "very_high";
export type CrowdTrend = "up" | "stable" | "down";
export type SignalKind =
  | "besttime"
  | "mastercard"
  | "telemetry"
  | "mobility"
  | "event"
  | "historical"
  | "unavailable";

export type PlaceInput = {
  id: number;
  fsq_place_id: string;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
};

export type CrowdCacheInput = {
  besttime_venue_id: string;
  crowd_score: number | null;
  confidence: string | null;
  fetched_at: string;
  expires_at: string;
  // The provider adapter must stamp this from the BestTime response.  A
  // forecast, cached legacy row, or unknown response can never masquerade as
  // a current observation.
  observation_mode: "live" | "forecast" | "unknown" | null;
};

export type EventInput = {
  id: number | string;
  place_id: number | null;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  start_at: string;
  end_at: string;
  is_active: boolean;
  expected_attendance?: number | null;
  source?: "editorial" | "community";
};

export type PresenceSnapshotInput = {
  place_id: number;
  window_start: string;
  window_end: string;
  confirmed_sessions: number;
  weighted_presence: number;
  average_presence_confidence: number;
  telemetry_observations: number;
  telemetry_sessions: number;
  telemetry_coverage: number | null;
};

export type PresenceProfileInput = {
  place_id: number;
  p25_weighted_presence: number;
  p50_weighted_presence: number;
  p75_weighted_presence: number;
  p90_weighted_presence: number;
  max_weighted_presence: number;
  sample_count: number;
  distinct_days: number;
  confidence: number;
};

export type HistoricalSlotInput = {
  place_id: number;
  local_weekday: number;
  local_hour: number;
  average_score: number;
  sample_count: number;
  distinct_days: number;
  besttime_samples: number;
  mastercard_samples?: number;
  telemetry_samples: number;
};

export type MastercardTransactionSnapshotInput = {
  place_id: number;
  window_start: string;
  window_end: string;
  transaction_count: number;
  source_coverage: number | null;
};

export type MastercardTransactionProfileInput = {
  place_id: number;
  p25_transaction_count: number;
  p50_transaction_count: number;
  p75_transaction_count: number;
  p90_transaction_count: number;
  max_transaction_count: number;
  sample_count: number;
  distinct_days: number;
  confidence: number;
};

export type MobilityProfileInput = {
  grid_key: string;
  local_day_type: "L" | "S" | "F";
  local_hour: number;
  service_intensity: number;
  mobility_score: number;
  stop_count: number;
  source_updated_at: string;
  refreshed_at: string;
};

export type EngineSignal = {
  placeId: number;
  source: "besttime" | "mastercard" | "live_city";
  signalType: "observed" | "forecast" | "baseline";
  kind: SignalKind;
  score: number;
  weight: number;
  confidence: number;
  observedAt: string;
  validUntil: string;
  metadata: Record<string, unknown>;
};

export type EstimateResult = {
  placeId: number;
  score: number;
  activityLevel: ActivityLevel;
  trend: CrowdTrend;
  confidence: number;
  dominantSource: SignalKind;
  signalCount: number;
  calculatedAt: string;
  validUntil: string;
  metadata: Record<string, unknown>;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_STALE_BESTTIME_AGE_MS = 24 * HOUR_MS;
const ESTIMATE_TTL_MS = 30 * MINUTE_MS;
const EVENT_LOOKAHEAD_MS = 4 * HOUR_MS;
const MAX_GEO_EVENT_DISTANCE_METERS = 250;
const MAX_TELEMETRY_AGE_MS = 40 * MINUTE_MS;
const MIN_TELEMETRY_SESSIONS = 5;
const MAX_MASTERCARD_AGE_MS = 40 * MINUTE_MS;
const MIN_MASTERCARD_TRANSACTIONS = 5;

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function romeClock(date: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const weekday = parts.find((part) => part.type === "weekday")?.value;

  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  return { hour, weekday: weekdayMap[weekday ?? ""] ?? 1 };
}

function confidenceNumber(value: string | null): number {
  switch (value) {
    case "high":
      return 0.9;
    case "medium":
      return 0.65;
    case "low":
      return 0.4;
    default:
      return 0.35;
  }
}

export function activityLevelFor(score: number): ActivityLevel {
  if (score >= 75) return "very_high";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

export function trendFor(score: number, previousScore: number | null): CrowdTrend {
  if (previousScore === null) return "stable";
  const delta = score - previousScore;
  if (delta >= 8) return "up";
  if (delta <= -8) return "down";
  return "stable";
}

export function buildHistoricalSignal(
  placeId: number,
  slot: HistoricalSlotInput | null,
  now: Date,
): EngineSignal | null {
  if (!slot || slot.sample_count < 12 || slot.distinct_days < 3) return null;
  if (!Number.isFinite(slot.average_score) || slot.average_score < 0 || slot.average_score > 100) return null;
  const clock = romeClock(now);
  if (slot.local_hour !== clock.hour || slot.local_weekday !== clock.weekday) return null;
  const sampleConfidence = clamp(slot.sample_count / 48, 0.35, 0.85);
  const dayConfidence = clamp(slot.distinct_days / 8, 0.35, 0.9);
  const confidence = Math.round(Math.min(sampleConfidence, dayConfidence) * 100) / 100;

  return {
    placeId,
    source: "live_city",
    signalType: "forecast",
    kind: "historical",
    score: Math.round(slot.average_score),
    weight: 0.7,
    confidence,
    observedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + HOUR_MS).toISOString(),
    metadata: {
      model: "observed_history_slot_v1",
      localHour: clock.hour,
      localWeekday: clock.weekday,
      sampleCount: slot.sample_count,
      distinctDays: slot.distinct_days,
      bestTimeSamples: slot.besttime_samples,
      mastercardSamples: slot.mastercard_samples ?? 0,
      telemetrySamples: slot.telemetry_samples,
    },
  };
}

export function buildBestTimeSignal(
  placeId: number,
  cache: CrowdCacheInput | null,
  now: Date,
): EngineSignal | null {
  if (
    !cache ||
    cache.observation_mode !== "live" ||
    cache.crowd_score === null ||
    !Number.isFinite(cache.crowd_score) ||
    cache.crowd_score < 0 ||
    cache.crowd_score > 100 ||
    cache.crowd_score === 999
  ) {
    return null;
  }

  const fetchedAt = new Date(cache.fetched_at).getTime();
  const expiresAt = new Date(cache.expires_at).getTime();
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(expiresAt)) return null;

  const ageMs = Math.max(0, now.getTime() - fetchedAt);
  if (ageMs > MAX_STALE_BESTTIME_AGE_MS) return null;

  const fresh = now.getTime() <= expiresAt;
  const staleDecay = clamp(1 - ageMs / MAX_STALE_BESTTIME_AGE_MS, 0.15, 1);
  const weight = fresh ? 1 : 0.55 * staleDecay;
  const confidence = fresh
    ? confidenceNumber(cache.confidence)
    : Math.min(0.5, confidenceNumber(cache.confidence) * staleDecay);

  return {
    placeId,
    source: "besttime",
    signalType: "observed",
    kind: "besttime",
    score: Math.round(cache.crowd_score),
    weight,
    confidence,
    observedAt: cache.fetched_at,
    validUntil: cache.expires_at,
    metadata: {
      stale: !fresh,
      ageMinutes: Math.round(ageMs / MINUTE_MS),
      providerVenueId: cache.besttime_venue_id,
      observationMode: cache.observation_mode,
    },
  };
}

function scoreFromTransactions(
  count: number,
  profile: MastercardTransactionProfileInput | null,
): number {
  if (!profile || profile.sample_count < 12 || profile.distinct_days < 3) {
    // A cold-start transaction count is not comparable across venues. Keep
    // the provisional score conservative until the venue has its own
    // percentile profile.
    return clamp(Math.round(12 + 17 * Math.log2(1 + count)), 0, 82);
  }

  const anchors = [
    { value: 0, score: 5 },
    { value: profile.p25_transaction_count, score: 25 },
    { value: profile.p50_transaction_count, score: 50 },
    { value: profile.p75_transaction_count, score: 72 },
    { value: profile.p90_transaction_count, score: 88 },
    {
      value: Math.max(profile.max_transaction_count, profile.p90_transaction_count + 1),
      score: 100,
    },
  ].sort((left, right) => left.value - right.value);

  for (let index = 1; index < anchors.length; index += 1) {
    const lower = anchors[index - 1];
    const upper = anchors[index];
    if (count <= upper.value) {
      if (upper.value === lower.value) return upper.score;
      const progress = (count - lower.value) / (upper.value - lower.value);
      return clamp(Math.round(lower.score + progress * (upper.score - lower.score)));
    }
  }

  return 100;
}

export function buildMastercardTransactionSignal(
  placeId: number,
  snapshot: MastercardTransactionSnapshotInput | null,
  profile: MastercardTransactionProfileInput | null,
  now: Date,
): EngineSignal | null {
  if (!snapshot || snapshot.transaction_count < MIN_MASTERCARD_TRANSACTIONS) return null;
  const windowEnd = new Date(snapshot.window_end).getTime();
  const ageMs = now.getTime() - windowEnd;
  if (
    !Number.isFinite(windowEnd) ||
    ageMs < -5 * MINUTE_MS ||
    ageMs > MAX_MASTERCARD_AGE_MS ||
    !Number.isInteger(snapshot.transaction_count)
  ) {
    return null;
  }

  const matureProfile = Boolean(
    profile && profile.sample_count >= 12 && profile.distinct_days >= 3,
  );
  const freshness = clamp(1 - Math.max(0, ageMs) / MAX_MASTERCARD_AGE_MS, 0.35, 1);
  // Unknown Mastercard/card-enrolment coverage must remain conservative; a
  // calibrated commercial coverage ratio can raise confidence later.
  const coverage = clamp(Number(snapshot.source_coverage ?? 0.2), 0.1, 1);
  const volumeConfidence = clamp(snapshot.transaction_count / 30, 0.3, 1);
  const profileConfidence = matureProfile
    ? clamp(Number(profile?.confidence ?? 0.5), 0.35, 0.9)
    : 0.4;
  const confidence = clamp(
    profileConfidence * (0.65 + 0.35 * volumeConfidence) * (0.7 + 0.3 * coverage) * freshness,
    0.25,
    matureProfile ? 0.78 : 0.45,
  );

  return {
    placeId,
    source: "mastercard",
    signalType: "observed",
    kind: "mastercard",
    score: scoreFromTransactions(snapshot.transaction_count, profile),
    // Card purchases are a useful near-real-time activity proxy, but do not
    // equal people: cash, other networks, repeat purchases and online orders
    // prevent a 1:1 conversion. It can complement, never overpower, a fresh
    // verified BestTime or LIVE CITY presence signal.
    weight: (matureProfile ? 0.72 : 0.38) * freshness,
    confidence: Math.round(confidence * 100) / 100,
    observedAt: snapshot.window_end,
    validUntil: new Date(windowEnd + MAX_MASTERCARD_AGE_MS).toISOString(),
    metadata: {
      sourceMode: "consented_transaction_count_proxy",
      transactionCount: snapshot.transaction_count,
      privacyThreshold: MIN_MASTERCARD_TRANSACTIONS,
      sourceCoverage: coverage,
      normalizedWithVenueProfile: matureProfile,
      ageMinutes: Math.max(0, Math.round(ageMs / MINUTE_MS)),
      disclaimer: "Aggregated payment activity proxy; not a count of people",
    },
  };
}

function scoreFromPresence(
  value: number,
  profile: PresenceProfileInput | null,
): number {
  if (!profile || profile.sample_count < 12 || profile.distinct_days < 3) {
    return clamp(Math.round(18 + 13 * Math.log2(1 + value)));
  }

  const anchors = [
    { value: 0, score: 8 },
    { value: profile.p25_weighted_presence, score: 30 },
    { value: profile.p50_weighted_presence, score: 50 },
    { value: profile.p75_weighted_presence, score: 70 },
    { value: profile.p90_weighted_presence, score: 86 },
    { value: Math.max(profile.max_weighted_presence, profile.p90_weighted_presence + 1), score: 100 },
  ].sort((left, right) => left.value - right.value);

  for (let index = 1; index < anchors.length; index += 1) {
    const lower = anchors[index - 1];
    const upper = anchors[index];
    if (value <= upper.value) {
      if (upper.value === lower.value) return upper.score;
      const progress = (value - lower.value) / (upper.value - lower.value);
      return clamp(Math.round(lower.score + progress * (upper.score - lower.score)));
    }
  }

  return 100;
}

export function buildTelemetrySignal(
  placeId: number,
  snapshot: PresenceSnapshotInput | null,
  profile: PresenceProfileInput | null,
  now: Date,
): EngineSignal | null {
  if (!snapshot) return null;
  const windowEnd = new Date(snapshot.window_end).getTime();
  const ageMs = now.getTime() - windowEnd;
  const sessions = Math.max(snapshot.confirmed_sessions, snapshot.telemetry_sessions);
  if (
    !Number.isFinite(windowEnd) ||
    ageMs < -5 * MINUTE_MS ||
    ageMs > MAX_TELEMETRY_AGE_MS ||
    sessions < MIN_TELEMETRY_SESSIONS ||
    !Number.isFinite(snapshot.weighted_presence) ||
    snapshot.weighted_presence < 0
  ) {
    return null;
  }

  const freshness = clamp(1 - Math.max(0, ageMs) / MAX_TELEMETRY_AGE_MS, 0.35, 1);
  const coverage = clamp(Number(snapshot.telemetry_coverage ?? 0.5), 0.2, 1);
  const sampleConfidence = clamp(sessions / 20, 0.35, 1);
  const confidence = clamp(
    snapshot.average_presence_confidence * coverage * sampleConfidence * freshness,
    0.35,
    0.92,
  );

  return {
    placeId,
    source: "live_city",
    signalType: "observed",
    kind: "telemetry",
    score: scoreFromPresence(snapshot.weighted_presence, profile),
    weight: 1 * freshness,
    confidence: Math.round(confidence * 100) / 100,
    observedAt: snapshot.window_end,
    validUntil: new Date(windowEnd + MAX_TELEMETRY_AGE_MS).toISOString(),
    metadata: {
      privacyThreshold: MIN_TELEMETRY_SESSIONS,
      confirmedSessions: sessions,
      observationCount: snapshot.telemetry_observations,
      coverage,
      ageMinutes: Math.max(0, Math.round(ageMs / MINUTE_MS)),
      normalizedWithProfile: Boolean(
        profile && profile.sample_count >= 12 && profile.distinct_days >= 3,
      ),
    },
  };
}

export function buildMobilitySignal(
  placeId: number,
  profile: MobilityProfileInput | null,
  now: Date,
): EngineSignal | null {
  if (
    !profile ||
    !Number.isFinite(profile.mobility_score) ||
    profile.mobility_score < 0 ||
    profile.mobility_score > 100 ||
    !Number.isFinite(profile.service_intensity) ||
    profile.service_intensity <= 0 ||
    profile.stop_count <= 0
  ) {
    return null;
  }

  return {
    placeId,
    source: "live_city",
    signalType: "forecast",
    kind: "mobility",
    score: Math.round(profile.mobility_score),
    // Scheduled public-transport supply is a useful spatial proxy, but it is
    // not a people counter. Keep it below telemetry and observed history.
    weight: 0.42,
    confidence: 0.55,
    observedAt: profile.refreshed_at,
    validUntil: new Date(now.getTime() + HOUR_MS).toISOString(),
    metadata: {
      model: "milan_scheduled_mobility_v1",
      sourceDataset: "Comune di Milano / AMAT scheduled public transport",
      sourceMode: "scheduled_proxy",
      localDayType: profile.local_day_type,
      localHour: profile.local_hour,
      serviceIntensity: Math.round(profile.service_intensity * 10) / 10,
      stopCount: profile.stop_count,
      sourceUpdatedAt: profile.source_updated_at,
      disclaimer: "Mobility index, not verified live foot traffic",
    },
  };
}

function distanceMeters(a: PlaceInput, event: EventInput): number {
  const radius = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(event.latitude - a.latitude);
  const deltaLongitude = toRadians(event.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(event.latitude);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLongitude / 2) ** 2;

  return radius * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function assignEventsToPlaces(
  places: PlaceInput[],
  events: EventInput[],
  now: Date,
): Map<number, EngineSignal[]> {
  const byPlace = new Map<number, EngineSignal[]>();
  const knownPlaceIds = new Set(places.map((place) => place.id));

  for (const event of events) {
    if (!event.is_active) continue;
    const startAt = new Date(event.start_at).getTime();
    const endAt = new Date(event.end_at).getTime();
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < now.getTime()) continue;

    const active = startAt <= now.getTime();
    const untilStartMs = startAt - now.getTime();
    if (!active && untilStartMs > EVENT_LOOKAHEAD_MS) continue;

    let placeId: number | null = null;
    let match: "direct" | "geo" = "direct";
    let matchedDistance: number | null = null;

    if (event.place_id !== null && knownPlaceIds.has(event.place_id)) {
      placeId = event.place_id;
    } else if (event.place_id === null) {
      const nearestSameCategory = places
        .filter((place) => place.category === event.category)
        .map((place) => ({ place, distance: distanceMeters(place, event) }))
        .filter(({ distance }) => distance <= MAX_GEO_EVENT_DISTANCE_METERS)
        .sort((left, right) => left.distance - right.distance)[0];
      // A very close venue can still be a prudent fallback when an event's
      // editorial category differs from the place catalogue category.
      const nearestAnyCategory = places
        .map((place) => ({ place, distance: distanceMeters(place, event) }))
        .filter(({ distance }) => distance <= 120)
        .sort((left, right) => left.distance - right.distance)[0];
      const nearest = nearestSameCategory ?? nearestAnyCategory;

      if (nearest) {
        placeId = nearest.place.id;
        match = "geo";
        matchedDistance = Math.round(nearest.distance);
      }
    }

    if (placeId === null) continue;

    const proximity = active ? 1 : clamp(1 - untilStartMs / EVENT_LOOKAHEAD_MS, 0, 1);
    // A community event is a declared attendance forecast, not a measurement.
    // Its size can inform the area forecast, but the signal remains explicitly
    // forecast-only and is capped so it cannot dominate real observations.
    const attendanceBoost = event.expected_attendance === null || event.expected_attendance === undefined
      ? 18
      : clamp(7 + 7 * Math.log2(1 + event.expected_attendance / 10), 8, 25);
    const rawBoost = active ? attendanceBoost : attendanceBoost * (0.3 + 0.7 * proximity);
    const matchFactor = match === "direct" ? 1 : 0.55;
    const boost = Math.round(rawBoost * matchFactor);
    const signal: EngineSignal = {
      placeId,
      source: "live_city",
      signalType: "forecast",
      kind: "event",
      score: boost,
      weight: active ? 0.8 * matchFactor : 0.55 * matchFactor,
      confidence: match === "direct" ? 0.8 : 0.45,
      observedAt: now.toISOString(),
      validUntil: event.end_at,
      metadata: {
        eventId: event.id,
        active,
        match,
        distanceMeters: matchedDistance,
        startsInMinutes: active ? 0 : Math.round(untilStartMs / MINUTE_MS),
        expectedAttendance: event.expected_attendance ?? null,
        eventSource: event.source ?? "editorial",
        contributionType: "additive_boost",
      },
    };
    byPlace.set(placeId, [...(byPlace.get(placeId) ?? []), signal]);
  }

  return byPlace;
}

export function calculateEstimate(
  placeId: number,
  signals: EngineSignal[],
  previousScore: number | null,
  now: Date,
): EstimateResult {
  const baseSignals = signals.filter((signal) => signal.kind !== "event");
  const eventSignals = signals.filter((signal) => signal.kind === "event");
  const totalWeight = baseSignals.reduce((sum, signal) => sum + signal.weight, 0);
  const baseScore = totalWeight > 0
    ? baseSignals.reduce((sum, signal) => sum + signal.score * signal.weight, 0) / totalWeight
    : 0;
  const eventBoost = Math.min(25, eventSignals.reduce((sum, signal) => sum + signal.score, 0));
  const score = Math.round(clamp(baseScore + eventBoost));
  const bestTime = baseSignals.find((signal) => signal.kind === "besttime");
  const telemetry = baseSignals.find((signal) => signal.kind === "telemetry");
  const mastercard = baseSignals.find((signal) => signal.kind === "mastercard");
  const observedSignals = baseSignals.filter((signal) => signal.signalType === "observed");
  const observedWeight = observedSignals.reduce((sum, signal) => sum + signal.weight, 0);
  const observedConfidence = observedWeight > 0
    ? observedSignals.reduce((sum, signal) => sum + signal.confidence * signal.weight, 0) / observedWeight
    : null;
  const hasVerifiedPresence = Boolean(telemetry || bestTime);
  const confidence = observedConfidence !== null
    ? clamp(
        observedConfidence + (eventSignals.length > 0 ? 0.03 : 0),
        0,
        hasVerifiedPresence ? 0.95 : 0.7,
      )
    : clamp(0.3 + (eventSignals.length > 0 ? 0.1 : 0), 0, 0.45);
  const dominantBase = [...baseSignals].sort((a, b) => b.weight - a.weight)[0];
  const dominantSource: SignalKind =
    eventSignals.length > 0 && eventSignals.reduce((sum, signal) => sum + signal.weight, 0) > (dominantBase?.weight ?? 0)
      ? "event"
      : dominantBase?.kind ?? "unavailable";
  const calculatedAt = now.toISOString();
  const validUntil = new Date(now.getTime() + ESTIMATE_TTL_MS).toISOString();

  return {
    placeId,
    score,
    activityLevel: activityLevelFor(score),
    trend: trendFor(score, previousScore),
    confidence: Math.round(confidence * 100) / 100,
    dominantSource,
    signalCount: signals.length,
    calculatedAt,
    validUntil,
    metadata: {
      formulaVersion: "crowd_engine_v3_besttime_mastercard",
      dataClass: hasVerifiedPresence
        ? "verified_live"
        : mastercard
        ? "transaction_proxy"
        : baseSignals.length > 0 || eventSignals.length > 0
        ? "forecast"
        : "unavailable",
      baseScore: Math.round(baseScore * 10) / 10,
      eventBoost,
      isFallback: !bestTime && !telemetry,
      // A declared event can yield a low-confidence forecast where no live
      // signal exists. It must be visible as an estimate, never discarded as
      // unavailable or represented as verified foot traffic.
      isUnavailable: baseSignals.length === 0 && eventSignals.length === 0,
      previousScore,
      contributions: signals.map((signal) => ({
        kind: signal.kind,
        score: signal.score,
        weight: Math.round(signal.weight * 100) / 100,
        confidence: signal.confidence,
        stale: signal.metadata.stale === true,
        sourceMode: signal.metadata.sourceMode ?? signal.signalType,
      })),
    },
  };
}

export function calculateHybridEstimate(
  placeId: number,
  signals: EngineSignal[],
  previousScore: number | null,
  now: Date,
): EstimateResult {
  const telemetry = signals.find((signal) => signal.kind === "telemetry");
  const forecasts = signals.filter((signal) =>
    signal.kind === "mobility" || signal.kind === "historical"
  );
  const events = signals.filter((signal) => signal.kind === "event");

  const forecastWeight = forecasts.reduce((sum, signal) => sum + signal.weight, 0);
  const forecastScore = forecastWeight > 0
    ? forecasts.reduce((sum, signal) => sum + signal.score * signal.weight, 0) / forecastWeight
    : null;

  // Fresh, privacy-safe telemetry remains the anchor. Scheduled mobility and
  // observed history may stabilise it, but together cannot outweigh the live
  // aggregate. Without telemetry the output is always an explicit forecast.
  const baseScore = telemetry
    ? forecastScore === null
      ? telemetry.score
      : telemetry.score * 0.75 + forecastScore * 0.25
    : forecastScore ?? 0;
  const eventBoost = Math.min(25, events.reduce((sum, signal) => sum + signal.score, 0));
  const hasAnySignal = Boolean(telemetry || forecasts.length > 0 || events.length > 0);
  const score = Math.round(clamp(baseScore + eventBoost));
  const forecastConfidence = forecastWeight > 0
    ? forecasts.reduce((sum, signal) => sum + signal.confidence * signal.weight, 0) / forecastWeight
    : 0.3;
  const confidence = telemetry
    ? clamp(telemetry.confidence + (forecasts.length > 0 ? 0.02 : 0), 0, 0.92)
    : clamp(forecastConfidence + (events.length > 0 ? 0.03 : 0), 0.3, 0.65);
  const dominantForecast = [...forecasts].sort((left, right) => right.weight - left.weight)[0];
  const dominantSource: SignalKind = telemetry
    ? "telemetry"
    : dominantForecast?.kind ?? (events.length > 0 ? "event" : "unavailable");
  const calculatedAt = now.toISOString();

  return {
    placeId,
    score,
    activityLevel: activityLevelFor(score),
    trend: trendFor(score, previousScore),
    confidence: Math.round(confidence * 100) / 100,
    dominantSource,
    signalCount: signals.length,
    calculatedAt,
    validUntil: new Date(now.getTime() + ESTIMATE_TTL_MS).toISOString(),
    metadata: {
      formulaVersion: "hybrid_telemetry_mobility_events_history_v1",
      strategy: "hybrid",
      dataClass: telemetry ? "verified_live" : hasAnySignal ? "forecast" : "unavailable",
      baseScore: Math.round(baseScore * 10) / 10,
      eventBoost,
      isFallback: !telemetry && hasAnySignal,
      isUnavailable: !hasAnySignal,
      previousScore,
      contributions: signals.map((signal) => ({
        kind: signal.kind,
        score: signal.score,
        weight: Math.round(signal.weight * 100) / 100,
        confidence: signal.confidence,
        sourceMode: signal.metadata.sourceMode ?? signal.signalType,
      })),
    },
  };
}
