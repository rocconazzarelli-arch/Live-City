export type PlaceCategory =
  | "aperitivo"
  | "food"
  | "nightlife"
  | "outdoor"
  | "culture";

export type ActivityLevel = "low" | "medium" | "high" | "very_high";
export type CrowdTrend = "up" | "stable" | "down";
export type SignalKind = "besttime" | "telemetry" | "event" | "temporal";

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
};

export type EventInput = {
  id: number;
  place_id: number | null;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  start_at: string;
  end_at: string;
  is_active: boolean;
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

export type EngineSignal = {
  placeId: number;
  source: "besttime" | "live_city";
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

type TimeSlot = {
  start: number;
  end: number;
  score: number;
};

type TemporalProfile = {
  defaultScore: number;
  weekendBonus: number;
  slots: TimeSlot[];
};

// Product-tunable Milan baselines. Slots use local Europe/Rome hours. A slot
// whose end is lower than its start crosses midnight.
export const TEMPORAL_PROFILES: Record<PlaceCategory, TemporalProfile> = {
  aperitivo: {
    defaultScore: 16,
    weekendBonus: 8,
    slots: [
      { start: 12, end: 16, score: 30 },
      { start: 16, end: 21, score: 65 },
      { start: 21, end: 1, score: 43 },
    ],
  },
  food: {
    defaultScore: 18,
    weekendBonus: 6,
    slots: [
      { start: 7, end: 10, score: 34 },
      { start: 12, end: 15, score: 62 },
      { start: 19, end: 23, score: 70 },
    ],
  },
  nightlife: {
    defaultScore: 7,
    weekendBonus: 12,
    slots: [
      { start: 20, end: 23, score: 38 },
      { start: 23, end: 5, score: 76 },
    ],
  },
  outdoor: {
    defaultScore: 14,
    weekendBonus: 10,
    slots: [
      { start: 7, end: 11, score: 47 },
      { start: 11, end: 19, score: 58 },
      { start: 19, end: 22, score: 32 },
    ],
  },
  culture: {
    defaultScore: 10,
    weekendBonus: 6,
    slots: [
      { start: 9, end: 19, score: 54 },
      { start: 19, end: 23, score: 31 },
    ],
  },
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_STALE_BESTTIME_AGE_MS = 24 * HOUR_MS;
const ESTIMATE_TTL_MS = 30 * MINUTE_MS;
const EVENT_LOOKAHEAD_MS = 4 * HOUR_MS;
const MAX_GEO_EVENT_DISTANCE_METERS = 250;
const MAX_TELEMETRY_AGE_MS = 40 * MINUTE_MS;
const MIN_TELEMETRY_SESSIONS = 5;

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function isHourInSlot(hour: number, slot: TimeSlot): boolean {
  if (slot.start < slot.end) {
    return hour >= slot.start && hour < slot.end;
  }

  return hour >= slot.start || hour < slot.end;
}

function romeClock(date: Date): { hour: number; weekend: boolean } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const weekday = parts.find((part) => part.type === "weekday")?.value;

  return {
    hour,
    weekend: weekday === "Sat" || weekday === "Sun",
  };
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

export function buildTemporalSignal(place: PlaceInput, now: Date): EngineSignal {
  const profile = TEMPORAL_PROFILES[place.category];
  const clock = romeClock(now);
  const slot = profile.slots.find((candidate) => isHourInSlot(clock.hour, candidate));
  const baseScore = slot?.score ?? profile.defaultScore;
  const score = Math.round(clamp(baseScore + (clock.weekend ? profile.weekendBonus : 0)));

  return {
    placeId: place.id,
    source: "live_city",
    signalType: "baseline",
    kind: "temporal",
    score,
    weight: 0.35,
    confidence: 0.3,
    observedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + HOUR_MS).toISOString(),
    metadata: {
      model: "milan_category_hour_v1",
      category: place.category,
      localHour: clock.hour,
      weekend: clock.weekend,
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
    const rawBoost = active ? 18 : 4 + 8 * proximity;
    const matchFactor = match === "direct" ? 1 : 0.55;
    const boost = Math.round(rawBoost * matchFactor);
    const signal: EngineSignal = {
      placeId,
      source: "live_city",
      signalType: active ? "observed" : "forecast",
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
  const liveSignal = telemetry ?? bestTime;
  const confidence = liveSignal
    ? clamp(liveSignal.confidence + (eventSignals.length > 0 ? 0.03 : 0), 0, 0.95)
    : clamp(0.3 + (eventSignals.length > 0 ? 0.1 : 0), 0, 0.45);
  const dominantBase = [...baseSignals].sort((a, b) => b.weight - a.weight)[0];
  const dominantSource: SignalKind =
    eventSignals.length > 0 && eventSignals.reduce((sum, signal) => sum + signal.weight, 0) > (dominantBase?.weight ?? 0)
      ? "event"
      : dominantBase?.kind ?? "temporal";
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
      formulaVersion: "crowd_engine_v1",
      baseScore: Math.round(baseScore * 10) / 10,
      eventBoost,
      isFallback: !bestTime && !telemetry,
      previousScore,
      contributions: signals.map((signal) => ({
        kind: signal.kind,
        score: signal.score,
        weight: Math.round(signal.weight * 100) / 100,
        confidence: signal.confidence,
        stale: signal.metadata.stale === true,
      })),
    },
  };
}
