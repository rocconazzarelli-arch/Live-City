import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DEMO_AREA_HEAT_CELLS } from '@/features/map/demo-heatmap';
import { loadSocialSession } from '@/lib/social-client';

/* =========================================================
   TYPES
========================================================= */

type PlaceCategory =
  | 'aperitivo'
  | 'food'
  | 'nightlife'
  | 'outdoor'
  | 'culture';

type CategoryFilter = 'all' | PlaceCategory;

type TimeFilter = 'now' | 'today' | 'week';

type MapDisplayMode = 'places' | 'crowd';

export type CrowdStrategy = 'besttime' | 'hybrid';

type ContributionStatus =
  | 'idle'
  | 'starting'
  | 'active'
  | 'waiting'
  | 'error';

type ActivityLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'very_high';

type CrowdTrend =
  | 'up'
  | 'stable'
  | 'down';

type CrowdConfidence =
  | 'low'
  | 'medium'
  | 'high';

type CrowdDataState =
  | 'fresh'
  | 'stale'
  | 'fallback'
  | 'unavailable';

type CrowdForecastPoint = {
  time: string;
  score: number;
  confidence: CrowdConfidence;
  sampleCount: number;
  distinctDays: number;
};

type Place = {
  id: string;
  fsqPlaceId: string;
  name: string;
  address: string | null;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  matched: boolean;
  bestTimeVenueId: string | null;
  hasCachedCrowd: boolean;
  crowdIsStale: boolean;
  crowdScore: number | null;
  activityLevel: ActivityLevel | null;
  trend: CrowdTrend | null;
  relativeToNormal: number | null;
  confidence: CrowdConfidence | null;
  crowdSource: string | null;
  crowdSources: string[];
  crowdUpdatedAt: string | null;
  crowdValidUntil: string | null;
  crowdIsFallback: boolean;
  crowdDataState: CrowdDataState;
  signalCount: number;
  crowdForecast: CrowdForecastPoint[];
  catalogSource: string | null;
};

type AreaHeatCell = {
  id: string;
  latitude: number;
  longitude: number;
  score: number;
  radius: number;
  distinctSessions: number;
};

type EventForecastCell = {
  id: string;
  latitude: number;
  longitude: number;
  score: number;
  radius: number;
  eventCount: number;
  expectedAttendance: number;
};

type MobilityForecastCell = {
  id: string;
  latitude: number;
  longitude: number;
  score: number;
  radius: number;
  serviceIntensity: number;
  stopCount: number;
};

type LiveEvent = {
  id: string;
  title: string;
  description: string | null;
  category: PlaceCategory;
  venueName: string | null;
  placeId: string | null;
  address: string | null;
  latitude: number;
  longitude: number;
  startAt: string;
  endAt: string;
  source: string;
  isActive: boolean;
  expectedAttendance: number | null;
  crowdForecastScore: number | null;
};

/* =========================================================
   CATEGORY CONFIG
========================================================= */

const categoryConfig: Record<
  PlaceCategory,
  {
    label: string;
    color: string;
    icon:
      | 'glass-cocktail'
      | 'silverware-fork-knife'
      | 'music-note'
      | 'tree-outline'
      | 'bank-outline';
  }
> = {
  aperitivo: {
    label: 'Aperitivo',
    color: '#FF4668',
    icon: 'glass-cocktail',
  },

  food: {
    label: 'Food',
    color: '#FF8A3D',
    icon: 'silverware-fork-knife',
  },

  nightlife: {
    label: 'Nightlife',
    color: '#7650D8',
    icon: 'music-note',
  },

  outdoor: {
    label: 'Outdoor',
    color: '#35A86B',
    icon: 'tree-outline',
  },

  culture: {
    label: 'Culture',
    color: '#3D82D8',
    icon: 'bank-outline',
  },
};

/* =========================================================
   SUPABASE
========================================================= */

const SUPABASE_PLACES_READ_URL =
  'https://qmskozzidachccwbtejd.supabase.co/functions/v1/places-read';

const SUPABASE_EVENTS_READ_URL =
  'https://qmskozzidachccwbtejd.supabase.co/functions/v1/events-read';

const SUPABASE_EVENTS_CREATE_URL =
  'https://qmskozzidachccwbtejd.supabase.co/functions/v1/events-create';

const SUPABASE_LOCATION_INGEST_URL =
  'https://qmskozzidachccwbtejd.supabase.co/functions/v1/location-ingest';

const SUPABASE_AREA_HEATMAP_READ_URL =
  'https://qmskozzidachccwbtejd.supabase.co/functions/v1/area-heatmap-read';

/* =========================================================
   MAP
========================================================= */

const MILAN_REGION = {
  latitude: 45.469,
  longitude: 9.188,
  latitudeDelta: 0.085,
  longitudeDelta: 0.085,
};

const DEMO_HEATMAP_ENABLED =
  __DEV__ && process.env.EXPO_PUBLIC_ENABLE_DEMO_HEATMAP === 'true';

const LOCATION_MIN_SEND_INTERVAL_MS = 5 * 60 * 1000;
const LOCATION_MAX_ACCURACY_METERS = 250;
const CLIENT_REFRESH_INTERVAL_MS = 20 * 60 * 1000;
const LOCATION_CONSENT_VERSION = '2026-10-private-beta-1';
const LOCATION_GRID_SIZE = 0.004;
const MILAN_BOUNDS = {
  south: 45.35,
  north: 45.58,
  west: 8.98,
  east: 9.35,
};

/* =========================================================
   HELPERS
========================================================= */

function getMarkerSize(crowdScore: number | null) {
  // A continuous scale makes nearby crowd levels legible without letting the
  // busiest venues dominate the map. Live or forecast scores stay in a more
  // compact 27–56px range than the previous 24–68px steps.
  if (crowdScore !== null && Number.isFinite(crowdScore)) {
    const boundedScore = Math.min(100, Math.max(0, crowdScore));
    return Math.round(27 + boundedScore * 0.29);
  }

  // Never infer a size from a category or activity label. Without a numeric
  // crowd observation/forecast the marker must stay visually neutral.
  return 30;
}

function getActivityLabel(
  activityLevel: ActivityLevel | null,
) {
  switch (activityLevel) {
    case 'very_high':
      return 'Molto attivo';

    case 'high':
      return 'Attivo';

    case 'medium':
      return 'Moderato';

    case 'low':
      return 'Poco attivo';

    default:
      return 'Dato non disponibile';
  }
}

function getTrendLabel(
  trend: CrowdTrend | null,
) {
  switch (trend) {
    case 'up':
      return 'In aumento';

    case 'down':
      return 'In diminuzione';

    case 'stable':
      return 'Stabile';

    default:
      return 'Trend non disponibile';
  }
}

function getTrendIcon(
  trend: CrowdTrend | null,
):
  | 'trending-up'
  | 'trending-down'
  | 'minus'
  | 'help' {
  switch (trend) {
    case 'up':
      return 'trending-up';

    case 'down':
      return 'trending-down';

    case 'stable':
      return 'minus';

    default:
      return 'help';
  }
}

function getCrowdDataLabel(
  place: Place,
) {
  if (
    place.crowdScore === null ||
    place.crowdDataState ===
      'unavailable'
  ) {
    return 'Dato non disponibile';
  }

  if (place.crowdSource === 'mastercard') return 'Stima transazioni';

  if (place.crowdIsFallback || place.crowdDataState === 'fallback') return 'Previsione';

  if (place.crowdDataState === 'stale') return 'Dato precedente';

  return 'Dato live';
}

function getCrowdProvenance(
  place: Place,
) {
  if (
    place.crowdScore === null ||
    place.crowdDataState === 'unavailable'
  ) {
    return 'Nessuna osservazione verificata disponibile';
  }

  if (place.crowdDataState === 'stale') {
    return place.crowdIsFallback
      ? 'Previsione precedente: aggiornamento in attesa'
      : 'Osservazione precedente: aggiornamento in attesa';
  }

  if (
    place.crowdSources.includes('besttime') &&
    place.crowdSources.includes('mastercard')
  ) {
    return 'Fusione BestTime Live + transazioni Mastercard aggregate';
  }

  if (
    place.crowdSources.includes('telemetry') &&
    place.crowdSources.includes('mastercard')
  ) {
    return 'Fusione presenze LIVE CITY + transazioni Mastercard aggregate';
  }

  if (place.crowdSource === 'besttime') {
    return 'BestTime Live verificato';
  }

  if (place.crowdSource === 'mastercard') {
    return 'Transazioni Mastercard aggregate · proxy, non conteggio persone';
  }

  if (place.crowdSource === 'live_city' || place.crowdSource === 'telemetry') {
    return 'Presenze LIVE CITY aggregate e anonime';
  }

  if (place.crowdSource === 'mobility') {
    return 'Indice di mobilità programmata · non è foot traffic live';
  }

  if (place.crowdSource === 'event') {
    return 'Previsione da eventi dichiarati · non è foot traffic live';
  }

  if (place.crowdSource === 'historical') {
    return 'Previsione dallo storico della telemetria LIVE CITY';
  }

  if (
    place.crowdIsFallback ||
    place.crowdDataState === 'fallback'
  ) {
    return 'Previsione da segnali disponibili, non foot traffic live';
  }

  return 'Osservazione live verificata';
}

function getForecastConfidenceLabel(confidence: CrowdConfidence) {
  if (confidence === 'high') return 'alta confidenza';
  if (confidence === 'medium') return 'media confidenza';
  return 'confidenza iniziale';
}

function formatCrowdUpdatedAt(
  value: string | null,
) {
  if (!value) return 'Orario non disponibile';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Orario non disponibile';
  return new Intl.DateTimeFormat(
    'it-IT',
    {
      timeZone: 'Europe/Rome',
      hour: '2-digit',
      minute: '2-digit',
    },
  ).format(date);
}

function formatEventDateTime(
  value: string,
) {
  const date = new Date(value);

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return 'Orario non disponibile';
  }

  return new Intl.DateTimeFormat(
    'it-IT',
    {
      timeZone: 'Europe/Rome',
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    },
  ).format(date);
}

const HEATMAP_RINGS = [
  { radiusMultiplier: 1.55, color: '#FFD84A', opacity: 0.16 },
  { radiusMultiplier: 1.24, color: '#FFB52E', opacity: 0.19 },
  { radiusMultiplier: 0.96, color: '#FF7A2F', opacity: 0.23 },
  { radiusMultiplier: 0.68, color: '#F1424E', opacity: 0.28 },
  { radiusMultiplier: 0.42, color: '#8C4DCE', opacity: 0.32 },
] as const;

function heatmapRingOpacity(score: number, baseOpacity: number) {
  // The response contains a privacy-safe 0–100 density score. Keep weaker
  // areas visible without making them look as intense as crowded ones.
  return baseOpacity * (0.38 + Math.min(Math.max(score, 0), 100) / 100 * 0.62);
}

function heatmapRingColor(hex: string, opacity: number) {
  const value = hex.replace('#', '');
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

function privacyGridKey(latitude: number, longitude: number): string {
  const latitudeCell = Math.floor(latitude / LOCATION_GRID_SIZE);
  const longitudeCell = Math.floor(longitude / LOCATION_GRID_SIZE);
  return `${latitudeCell}:${longitudeCell}`;
}

async function requestJsonWithRetry(
  url: string,
  options: RequestInit,
) {
  let lastResponse: Response | null = null;
  let lastData: any = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const raw = await response.text();
      const data: any = raw ? JSON.parse(raw) : null;
      if (response.ok) return { response, data };
      lastResponse = response;
      lastData = data;
    } catch {
      // The map keeps its last successful content during a temporary failure.
    }

    if (attempt === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }

  return { response: lastResponse, data: lastData };
}

/* =========================================================
   SCREEN
========================================================= */

export function LiveCityMapScreen({
  crowdStrategy = 'besttime',
}: {
  crowdStrategy?: CrowdStrategy;
}) {
  const [places, setPlaces] =
    useState<Place[]>([]);

  const [events, setEvents] =
    useState<LiveEvent[]>([]);

  const [selectedPlace, setSelectedPlace] =
    useState<Place | null>(null);

  const [selectedEvent, setSelectedEvent] =
    useState<LiveEvent | null>(null);

  const [selectedCategory, setSelectedCategory] =
    useState<CategoryFilter>('all');

  const [selectedTime, setSelectedTime] =
    useState<TimeFilter>('now');

  const [loadingPlaces, setLoadingPlaces] =
    useState(true);

  const [loadingEvents, setLoadingEvents] =
    useState(true);

  const [placesRefreshUnavailable, setPlacesRefreshUnavailable] =
    useState(false);

  const [eventsRefreshUnavailable, setEventsRefreshUnavailable] =
    useState(false);

  const [mapDisplayMode, setMapDisplayMode] =
    useState<MapDisplayMode>(DEMO_HEATMAP_ENABLED ? 'crowd' : 'places');

  const [areaHeatCells, setAreaHeatCells] =
    useState<AreaHeatCell[]>([]);

  const [eventForecastCells, setEventForecastCells] =
    useState<EventForecastCell[]>([]);

  const [mobilityForecastCells, setMobilityForecastCells] =
    useState<MobilityForecastCell[]>([]);

  const [eventComposerOpen, setEventComposerOpen] =
    useState(false);

  const [eventTitle, setEventTitle] =
    useState('');

  const [eventDescription, setEventDescription] =
    useState('');

  const [eventCategory, setEventCategory] =
    useState<PlaceCategory>('nightlife');

  const [eventAttendance, setEventAttendance] =
    useState('30');

  const [eventZone, setEventZone] =
    useState({ latitude: MILAN_REGION.latitude, longitude: MILAN_REGION.longitude });

  const [creatingEvent, setCreatingEvent] =
    useState(false);

  const [contributionEnabled, setContributionEnabled] =
    useState(false);

  const [contributionStatus, setContributionStatus] =
    useState<ContributionStatus>('idle');

  const [lastContributionAt, setLastContributionAt] =
    useState<string | null>(null);

  const locationSubscriptionRef =
    useRef<Location.LocationSubscription | null>(null);

  const locationSessionIdRef =
    useRef<string | null>(null);

  const lastSentLocationRef = useRef<{ gridKey: string; sentAt: number } | null>(null);

  const loading =
    loadingPlaces ||
    loadingEvents;

  /* =======================================================
     LOAD PLACES
  ======================================================= */

  useEffect(() => {
    let cancelled = false;

    const loadPlaces = async () => {
      try {
        setLoadingPlaces(true);

        const supabaseKey =
          process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

        if (!supabaseKey) {
          if (!cancelled) setPlacesRefreshUnavailable(true);

          return;
        }

        const placesReadUrl = crowdStrategy === 'hybrid'
          ? `${SUPABASE_PLACES_READ_URL}?strategy=hybrid`
          : SUPABASE_PLACES_READ_URL;
        const { response, data } = await requestJsonWithRetry(
          placesReadUrl,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey },
          },
        );

        if (
          !response ||
          !data?.success
        ) {
          if (!cancelled) setPlacesRefreshUnavailable(true);

          return;
        }

        const loadedPlaces: Place[] =
          (data.places ?? []).map(
            (place: {
              id: number | string;
              fsqPlaceId: string;
              name: string;
              address: string | null;
              category: PlaceCategory;
              latitude: number;
              longitude: number;
              matched: boolean;
              bestTimeVenueId: string | null;
              hasCachedCrowd: boolean;
              crowdIsStale: boolean;
              crowdScore: number | null;
              activityLevel: ActivityLevel | null;
              trend: CrowdTrend | null;
              confidence:
                | number
                | CrowdConfidence
                | null;
              crowdSource?: string | null;
              crowdSources?: string[];
              crowdUpdatedAt?: string | null;
              crowdValidUntil?: string | null;
              crowdIsFallback?: boolean;
              crowdDataState?: CrowdDataState;
              signalCount?: number;
              crowdForecast?: {
                time: string;
                score: number;
                confidence: CrowdConfidence;
                sampleCount: number;
                distinctDays: number;
              }[];
              catalogSource?: string | null;
            }) => ({
              id:
                String(
                  place.id ??
                    place.fsqPlaceId,
                ),

              fsqPlaceId:
                place.fsqPlaceId,

              name:
                place.name,

              address:
                place.address,

              category:
                place.category,

              latitude:
                place.latitude,

              longitude:
                place.longitude,

              matched:
                place.matched,

              bestTimeVenueId:
                place.bestTimeVenueId,

              hasCachedCrowd:
                place.hasCachedCrowd,

              crowdIsStale:
                place.crowdIsStale,

              crowdScore:
                place.crowdScore,

              activityLevel:
                place.activityLevel,

              trend:
                place.trend,

              relativeToNormal:
                null,

              confidence:
                typeof place.confidence ===
                'string'
                  ? place.confidence
                  : null,

              crowdSource:
                place.crowdSource ??
                null,

              crowdSources:
                (place.crowdSources ?? []).filter(
                  (source) => typeof source === 'string',
                ),

              crowdUpdatedAt:
                place.crowdUpdatedAt ??
                null,

              crowdValidUntil:
                place.crowdValidUntil ??
                null,

              crowdIsFallback:
                place.crowdIsFallback ??
                false,

              crowdDataState:
                place.crowdDataState ??
                (place.crowdScore ===
                null
                  ? 'unavailable'
                  : place.crowdIsStale
                    ? 'stale'
                    : 'fresh'),

              signalCount:
                place.signalCount ??
                0,

              crowdForecast:
                (place.crowdForecast ?? []).filter(
                  (forecast) =>
                    Number.isFinite(forecast.score) &&
                    forecast.score >= 0 &&
                    forecast.score <= 100,
                ),

              catalogSource:
                place.catalogSource ??
                null,
            }),
          );

        if (cancelled) {
          return;
        }

        setPlaces(
          loadedPlaces,
        );
        setPlacesRefreshUnavailable(false);
      } catch {
        if (!cancelled) {
          setPlacesRefreshUnavailable(true);
        }
      } finally {
        if (!cancelled) {
          setLoadingPlaces(false);
        }
      }
    };

    void loadPlaces();
    const refreshInterval = setInterval(
      () => void loadPlaces(),
      CLIENT_REFRESH_INTERVAL_MS,
    );

    return () => {
      cancelled = true;
      clearInterval(refreshInterval);
    };
  }, [crowdStrategy]);

  /* =======================================================
     LOAD EVENTS
  ======================================================= */

  useEffect(() => {
    let cancelled = false;

    const loadEvents = async () => {
      try {
        setLoadingEvents(true);

        const supabaseKey =
          process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

        if (!supabaseKey) {
          if (!cancelled) setEventsRefreshUnavailable(true);

          return;
        }

        const { response, data } = await requestJsonWithRetry(
          SUPABASE_EVENTS_READ_URL,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${supabaseKey}`,
              apikey: supabaseKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              window: selectedTime,
              category: selectedCategory,
              limit: 100,
            }),
          },
        );

        if (
          !response ||
          !data?.ok
        ) {
          if (!cancelled) setEventsRefreshUnavailable(true);

          return;
        }

        const loadedEvents: LiveEvent[] =
          (data.events ?? []).map(
            (event: {
              id: number | string;
              title: string;
              description: string | null;
              category: PlaceCategory;
              venue_name: string | null;
              place_id: number | string | null;
              address: string | null;
              latitude: number;
              longitude: number;
              start_at: string;
              end_at: string;
              source: string;
              is_active: boolean;
              expected_attendance?: number | null;
              crowd_forecast_score?: number | null;
            }) => ({
              id:
                String(
                  event.id,
                ),

              title:
                event.title,

              description:
                event.description,

              category:
                event.category,

              venueName:
                event.venue_name,

              placeId:
                event.place_id ===
                null
                  ? null
                  : String(
                      event.place_id,
                    ),

              address:
                event.address,

              latitude:
                event.latitude,

              longitude:
                event.longitude,

              startAt:
                event.start_at,

              endAt:
                event.end_at,

              source:
                event.source,

              isActive:
                event.is_active,

              expectedAttendance:
                typeof event.expected_attendance === 'number'
                  ? event.expected_attendance
                  : null,

              crowdForecastScore:
                typeof event.crowd_forecast_score === 'number'
                  ? event.crowd_forecast_score
                  : null,
            }),
          );

        if (cancelled) {
          return;
        }

        setEvents(
          loadedEvents,
        );
        setEventsRefreshUnavailable(false);
      } catch {
        if (!cancelled) {
          setEventsRefreshUnavailable(true);
        }
      } finally {
        if (!cancelled) {
          setLoadingEvents(false);
        }
      }
    };

    void loadEvents();
    const refreshInterval = setInterval(
      () => void loadEvents(),
      CLIENT_REFRESH_INTERVAL_MS,
    );

    return () => {
      cancelled = true;
      clearInterval(refreshInterval);
    };
  }, [
    selectedTime,
    selectedCategory,
  ]);

  /* =======================================================
     FILTERED PLACES
  ======================================================= */

  const filteredPlaces = useMemo(() => {
    const rank = (place: Place) => {
      const sourceWeight =
        place.crowdDataState === 'fresh' && !place.crowdIsFallback
          ? 4
          : place.crowdDataState === 'stale'
            ? 3
            : place.crowdDataState === 'fallback'
              ? 2
              : 1;
      const confidenceWeight = place.confidence === 'high' ? 3 : place.confidence === 'medium' ? 2 : 1;
      return sourceWeight * 1000 + confidenceWeight * 100 + (place.crowdScore ?? 0);
    };

    const topThirty = (category: PlaceCategory) => places
      .filter((place) => place.category === category)
      .sort((left, right) => rank(right) - rank(left) || left.name.localeCompare(right.name))
      .slice(0, 30);

    if (selectedCategory !== 'all') return topThirty(selectedCategory);
    return (Object.keys(categoryConfig) as PlaceCategory[]).flatMap(topThirty);
  }, [places, selectedCategory]);

  const hasLiveAreaHeatmap = areaHeatCells.length > 0;
  const hasEventAreaForecast = eventForecastCells.length > 0;
  const hasMobilityAreaForecast = mobilityForecastCells.length > 0;
  const displayedAreaHeatCells = DEMO_HEATMAP_ENABLED
    ? DEMO_AREA_HEAT_CELLS
    : areaHeatCells;
  const showHeatmap = mapDisplayMode === 'crowd';
  const showPlaceMarkers = mapDisplayMode === 'places';
  const hasVisibleCrowdScore = filteredPlaces.some((place) =>
    place.crowdScore !== null && Number.isFinite(place.crowdScore),
  );
  const showCrowdUnavailableNotice =
    !loading &&
    showPlaceMarkers &&
    filteredPlaces.length > 0 &&
    !hasVisibleCrowdScore;

  const heatmapLabel =
    DEMO_HEATMAP_ENABLED
      ? `SIMULAZIONE · ${DEMO_AREA_HEAT_CELLS.length} hotspot dimostrativi · dati non reali`
      : placesRefreshUnavailable
      ? places.length > 0
        ? 'Aggiornamento luoghi temporaneamente non disponibile'
        : 'Catalogo luoghi temporaneamente non disponibile'
      : eventsRefreshUnavailable
        ? 'Eventi temporaneamente non disponibili'
        : hasLiveAreaHeatmap
          ? `Heat map live · ${areaHeatCells.length} zone aggregate${hasMobilityAreaForecast ? ` · ${mobilityForecastCells.length} mobilità` : ''}${hasEventAreaForecast ? ` · ${eventForecastCells.length} eventi` : ''}`
          : hasMobilityAreaForecast
            ? `Mobilità programmata · ${mobilityForecastCells.length} zone${hasEventAreaForecast ? ` · ${eventForecastCells.length} eventi` : ''}`
          : hasEventAreaForecast
            ? `Previsioni evento · ${eventForecastCells.length} zone dichiarate`
          : 'Nessuna presenza live verificata';

  useEffect(() => {
    let cancelled = false;

    const loadAreaHeatmap = async () => {
      const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      if (!supabaseKey) return;

      try {
        const heatmapReadUrl = crowdStrategy === 'hybrid'
          ? `${SUPABASE_AREA_HEATMAP_READ_URL}?strategy=hybrid`
          : SUPABASE_AREA_HEATMAP_READ_URL;
        const response = await fetch(heatmapReadUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${supabaseKey}`,
            apikey: supabaseKey,
          },
        });
        const data = await response.json();
        if (!response.ok || !data.success || cancelled) return;

        setAreaHeatCells(
          (data.cells ?? []).map((cell: {
            id: string;
            latitude: number;
            longitude: number;
            score: number;
            radius: number;
            distinctSessions: number;
          }) => ({
            id: cell.id,
            latitude: cell.latitude,
            longitude: cell.longitude,
            score: cell.score,
            radius: cell.radius,
            distinctSessions: cell.distinctSessions,
          })),
        );
        setEventForecastCells(
          (data.eventForecastCells ?? []).map((cell: {
            id: string;
            latitude: number;
            longitude: number;
            score: number;
            radius: number;
            eventCount: number;
            expectedAttendance: number;
          }) => ({
            id: cell.id,
            latitude: cell.latitude,
            longitude: cell.longitude,
            score: cell.score,
            radius: cell.radius,
            eventCount: cell.eventCount,
            expectedAttendance: cell.expectedAttendance,
          })),
        );
        setMobilityForecastCells(
          (data.mobilityForecastCells ?? []).map((cell: {
            id: string;
            latitude: number;
            longitude: number;
            score: number;
            radius: number;
            serviceIntensity: number;
            stopCount: number;
          }) => ({
            id: cell.id,
            latitude: cell.latitude,
            longitude: cell.longitude,
            score: cell.score,
            radius: cell.radius,
            serviceIntensity: cell.serviceIntensity,
            stopCount: cell.stopCount,
          })),
        );
      } catch {
        // The absence of a heatmap must never produce a development overlay.
      }
    };

    void loadAreaHeatmap();
    const refreshInterval = setInterval(
      () => void loadAreaHeatmap(),
      CLIENT_REFRESH_INTERVAL_MS,
    );

    return () => {
      cancelled = true;
      clearInterval(refreshInterval);
    };
  }, [crowdStrategy]);

  const stopLocationContribution = () => {
    locationSubscriptionRef.current?.remove();
    locationSubscriptionRef.current = null;
    lastSentLocationRef.current = null;
    locationSessionIdRef.current = null;
    setContributionEnabled(false);
    setContributionStatus('idle');
  };

  const sendLocationObservation = async (
    location: Location.LocationObject,
  ) => {
    const accuracy = location.coords.accuracy;
    if (accuracy !== null && accuracy > LOCATION_MAX_ACCURACY_METERS) {
      setContributionStatus('waiting');
      return;
    }

    const now = Date.now();
    const nextPoint = {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    };
    if (
      nextPoint.latitude < MILAN_BOUNDS.south ||
      nextPoint.latitude > MILAN_BOUNDS.north ||
      nextPoint.longitude < MILAN_BOUNDS.west ||
      nextPoint.longitude > MILAN_BOUNDS.east
    ) {
      setContributionStatus('waiting');
      return;
    }
    const previous = lastSentLocationRef.current;
    const gridKey = privacyGridKey(nextPoint.latitude, nextPoint.longitude);
    if (
      previous &&
      now - previous.sentAt < LOCATION_MIN_SEND_INTERVAL_MS &&
      previous.gridKey === gridKey
    ) {
      setContributionStatus('waiting');
      return;
    }

    const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const sessionId = locationSessionIdRef.current;
    if (!supabaseKey || !sessionId) {
      setContributionStatus('error');
      return;
    }

    const response = await fetch(SUPABASE_LOCATION_INGEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        apikey: supabaseKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId,
        // The GPS fix stays on-device. The backend receives only a roughly
        // 440m privacy cell and derives the cell centre server-side.
        gridKey,
        accuracyMeters: accuracy,
        observedAt: new Date(location.timestamp).toISOString(),
        consentVersion: LOCATION_CONSENT_VERSION,
      }),
    });

    const result = await response.json().catch(() => null) as {
      ok?: boolean;
      accepted?: boolean;
    } | null;
    if (!response.ok || !result?.ok) {
      console.warn('LOCATION INGEST ERROR:', response.status);
      setContributionStatus('error');
      return;
    }

    if (result.accepted) {
      lastSentLocationRef.current = { gridKey, sentAt: now };
      setLastContributionAt(new Date().toISOString());
      setContributionStatus('active');
    } else {
      // The server saw this session recently. Mirror that gate locally so a
      // burst of GPS callbacks cannot create repeated network requests.
      lastSentLocationRef.current = { gridKey, sentAt: now };
      setContributionStatus('waiting');
    }
  };

  const startLocationContribution = async () => {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) {
      Alert.alert(
        'Posizione non attiva',
        'LIVE CITY funziona comunque. Puoi abilitarla in seguito dalle impostazioni del telefono.',
      );
      return;
    }

    locationSessionIdRef.current = Crypto.randomUUID();
    setContributionEnabled(true);
    setContributionStatus('starting');

    // A watcher can wait for movement. Send one current, foreground fix now
    // so that a consenting person can contribute immediately.
    try {
      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      await sendLocationObservation(currentLocation);
    } catch (error) {
      // The watcher below can still supply the next valid GPS fix.
      console.warn('LOCATION INITIAL FIX ERROR:', error);
      setContributionStatus('error');
    }

    try {
      locationSubscriptionRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: 100,
          timeInterval: LOCATION_MIN_SEND_INTERVAL_MS,
        },
        (location) => {
          void sendLocationObservation(location).catch((error) => {
            console.warn('LOCATION INGEST ERROR:', error);
            setContributionStatus('error');
          });
        },
      );
    } catch (error) {
      console.warn('LOCATION WATCH ERROR:', error);
      stopLocationContribution();
      setContributionStatus('error');
    }
  };

  const handleContributionPress = () => {
    if (contributionEnabled) {
      stopLocationContribution();
      return;
    }

    Alert.alert(
      'Contribuisci alla mappa live?',
      'Se accetti, LIVE CITY usa la posizione solo mentre l’app è aperta. Il telefono invia una zona approssimata, non le coordinate GPS precise, insieme a un identificatore casuale di sessione. Puoi interrompere quando vuoi; le zone diventano visibili solo con almeno 5 persone.',
      [
        { text: 'Non ora', style: 'cancel' },
        {
          text: 'Attiva',
          onPress: () => {
            void startLocationContribution();
          },
        },
      ],
    );
  };

  useEffect(
    () => () => {
      locationSubscriptionRef.current?.remove();
    },
    [],
  );

  const handleCreateEvent = async () => {
    const title = eventTitle.trim();
    const expectedAttendance = Number(eventAttendance);
    if (title.length < 3) {
      Alert.alert('Titolo troppo breve', 'Inserisci almeno 3 caratteri.');
      return;
    }
    if (!Number.isInteger(expectedAttendance) || expectedAttendance < 2 || expectedAttendance > 5000) {
      Alert.alert('Partecipanti non validi', 'Indica un numero tra 2 e 5.000.');
      return;
    }

    const session = await loadSocialSession();
    if (!session) {
      Alert.alert(
        'Accedi per pubblicare',
        'La creazione degli eventi richiede un account, così possiamo proteggere la community e permetterti di gestire i tuoi eventi.',
      );
      return;
    }

    setCreatingEvent(true);
    try {
      const startAt = new Date();
      const endAt = new Date(startAt.getTime() + 3 * 60 * 60 * 1000);
      const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      if (!key) throw new Error('Configurazione non disponibile');
      const response = await fetch(SUPABASE_EVENTS_CREATE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          apikey: key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title,
          description: eventDescription.trim() || null,
          category: eventCategory,
          latitude: eventZone.latitude,
          longitude: eventZone.longitude,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          expectedAttendance,
        }),
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; error?: string; event?: Record<string, unknown> } | null;
      if (!response.ok || !data?.ok || !data.event) throw new Error(data?.error ?? 'Evento non pubblicato');

      const created = data.event;
      setEvents((current) => [{
        id: String(created.id),
        title: String(created.title),
        description: typeof created.description === 'string' ? created.description : null,
        category: created.category as PlaceCategory,
        venueName: null,
        placeId: typeof created.place_id === 'number' ? String(created.place_id) : null,
        address: 'Zona scelta dall’organizzatore',
        latitude: Number(created.latitude),
        longitude: Number(created.longitude),
        startAt: String(created.start_at),
        endAt: String(created.end_at),
        source: 'community',
        isActive: true,
        expectedAttendance,
        crowdForecastScore: null,
      }, ...current]);
      setEventComposerOpen(false);
      setEventTitle('');
      setEventDescription('');
      setEventAttendance('30');
      Alert.alert('Evento pubblicato', 'Il crowd engine lo elaborerà come previsione dichiarata della zona entro il prossimo ciclo di 20 minuti.');
    } catch (error) {
      Alert.alert('Evento non pubblicato', error instanceof Error ? error.message : 'Riprova tra poco.');
    } finally {
      setCreatingEvent(false);
    }
  };

  /* =======================================================
     SELECTION
  ======================================================= */

  const handlePlacePress = (
    place: Place,
  ) => {
    setSelectedEvent(null);
    setSelectedPlace(place);
  };

  const handleEventPress = (
    event: LiveEvent,
  ) => {
    setSelectedPlace(null);
    setSelectedEvent(event);
  };

  const handleTimeChange = (
    time: TimeFilter,
  ) => {
    setSelectedPlace(null);
    setSelectedEvent(null);
    setSelectedTime(time);
  };

  const handleCategoryChange = (
    category: CategoryFilter,
  ) => {
    setSelectedPlace(null);
    setSelectedEvent(null);
    setSelectedCategory(category);
  };

  const handleDisplayModeChange = (mode: MapDisplayMode) => {
    setSelectedPlace(null);
    setSelectedEvent(null);
    setMapDisplayMode(mode);
  };

  /* =======================================================
     RENDER
  ======================================================= */

  return (
    <View style={styles.container}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={MILAN_REGION}
        mapType={
          Platform.OS === 'ios' && showHeatmap
            ? 'mutedStandard'
            : 'standard'
        }
        showsUserLocation={contributionEnabled}
        showsMyLocationButton={false}
        onRegionChangeComplete={(region) => {
          setEventZone({ latitude: region.latitude, longitude: region.longitude });
        }}
      >
        {showHeatmap && displayedAreaHeatCells.length > 0 &&
          displayedAreaHeatCells.flatMap((cell) =>
            HEATMAP_RINGS.map((ring, index) => (
              <Circle
                key={`heat-${cell.id}-${ring.radiusMultiplier}`}
                center={{ latitude: cell.latitude, longitude: cell.longitude }}
                radius={cell.radius * ring.radiusMultiplier}
                fillColor={heatmapRingColor(
                  ring.color,
                  heatmapRingOpacity(cell.score, ring.opacity),
                )}
                strokeColor="transparent"
                zIndex={5 + index}
              />
            )),
          )}

        {showHeatmap && mobilityForecastCells.flatMap((cell) =>
          HEATMAP_RINGS.map((ring, index) => (
            <Circle
              key={`mobility-forecast-${cell.id}-${ring.radiusMultiplier}`}
              center={{ latitude: cell.latitude, longitude: cell.longitude }}
              radius={cell.radius * ring.radiusMultiplier}
              fillColor={heatmapRingColor(
                '#16A7A0',
                heatmapRingOpacity(cell.score, ring.opacity * 0.5),
              )}
              strokeColor="transparent"
              zIndex={8 + index}
            />
          )),
        )}

        {showHeatmap && eventForecastCells.flatMap((cell) =>
          HEATMAP_RINGS.map((ring, index) => (
            <Circle
              key={`event-forecast-${cell.id}-${ring.radiusMultiplier}`}
              center={{ latitude: cell.latitude, longitude: cell.longitude }}
              radius={cell.radius * ring.radiusMultiplier}
              fillColor={heatmapRingColor(
                '#2F7BE5',
                heatmapRingOpacity(cell.score, ring.opacity * 0.7),
              )}
              strokeColor="transparent"
              zIndex={11 + index}
            />
          )),
        )}

        {showPlaceMarkers && filteredPlaces.map(
          (place) => {
            const config =
              categoryConfig[
                place.category
              ];

            const markerSize = getMarkerSize(place.crowdScore);

            return (
              <Marker
                key={`place-${place.id}`}
                coordinate={{
                  latitude:
                    place.latitude,

                  longitude:
                    place.longitude,
                }}
                onPress={() =>
                  handlePlacePress(
                    place,
                  )
                }
                tracksViewChanges={false}
                opacity={showHeatmap ? 0.72 : 1}
                zIndex={20}
              >
                <View
                  style={[
                    styles.marker,

                    {
                      width:
                        markerSize,

                      height:
                        markerSize,

                      borderRadius:
                        markerSize /
                        2,

                      backgroundColor:
                        config.color,
                    },
                  ]}
                >
                  <MaterialCommunityIcons
                    name={
                      config.icon
                    }
                    size={
                      Math.max(
                        14,
                        markerSize *
                          0.5,
                      )
                    }
                    color="#FFFFFF"
                  />
                </View>
              </Marker>
            );
          },
        )}

        {showPlaceMarkers && events.map(
          (event) => {
            const config =
              categoryConfig[
                event.category
              ];

            return (
              <Marker
                key={`event-${event.id}`}
                coordinate={{
                  latitude:
                    event.latitude,

                  longitude:
                    event.longitude,
                }}
                onPress={() =>
                  handleEventPress(
                    event,
                  )
                }
                tracksViewChanges={false}
                zIndex={1000}
              >
                <View
                  style={
                    styles.eventMarker
                  }
                >
                  <MaterialCommunityIcons
                    name="calendar-star"
                    size={23}
                    color="#FFFFFF"
                  />

                  <View
                    style={[
                      styles.eventMarkerBadge,

                      {
                        backgroundColor:
                          config.color,
                      },
                    ]}
                  />
                </View>
              </Marker>
            );
          },
        )}
      </MapView>

      <SafeAreaView
        pointerEvents="box-none"
        style={
          styles.safeArea
        }
      >
        <View
          style={
            styles.topRow
          }
        >
          <View
            style={
              styles.cityPill
            }
          >
            <MaterialCommunityIcons
              name="map-marker"
              size={17}
              color="#111111"
            />

            <Text
              style={
                styles.cityText
              }
            >
              Milano
            </Text>
          </View>

          <View
            style={
              styles.topActions
            }
          >
            <Pressable
              accessibilityLabel="Mostra la modalita Zone affollate"
              onPress={() => handleDisplayModeChange('crowd')}
              style={[styles.iconButton, showHeatmap && styles.iconButtonActive]}
            >
              <MaterialCommunityIcons
                name="blur"
                size={22}
                color={showHeatmap ? '#FFFFFF' : '#111111'}
              />
            </Pressable>

            <Pressable
              accessibilityLabel="Mostra la modalita Luoghi"
              onPress={() => handleDisplayModeChange('places')}
              style={[styles.iconButton, showPlaceMarkers && styles.iconButtonActive]}
            >
              <MaterialCommunityIcons
                name="map-marker-radius-outline"
                size={22}
                color={showPlaceMarkers ? '#FFFFFF' : '#111111'}
              />
            </Pressable>

            <Pressable
              accessibilityLabel="Contribuisci con la posizione"
              onPress={handleContributionPress}
              style={[
                styles.iconButton,
                contributionEnabled && styles.locationButtonActive,
              ]}
            >
              <MaterialCommunityIcons
                name={contributionEnabled ? 'crosshairs-gps' : 'crosshairs'}
                size={22}
                color={contributionEnabled ? '#FFFFFF' : '#111111'}
              />
            </Pressable>

            <Pressable
              accessibilityLabel="Crea un evento nella zona selezionata"
              onPress={() => setEventComposerOpen(true)}
              style={styles.iconButton}
            >
              <MaterialCommunityIcons
                name="calendar-plus"
                size={22}
                color="#111111"
              />
            </Pressable>
          </View>
        </View>

        <View
          style={
            styles.timeRow
          }
        >
          <Pressable
            onPress={() =>
              handleTimeChange(
                'now',
              )
            }
            style={[
              styles.timeChip,

              selectedTime ===
                'now' &&
                styles.timeChipSelected,
            ]}
          >
            <Text
              style={[
                styles.timeChipText,

                selectedTime ===
                  'now' &&
                  styles.timeChipTextSelected,
              ]}
            >
              Adesso
            </Text>
          </Pressable>

          <Pressable
            onPress={() =>
              handleTimeChange(
                'today',
              )
            }
            style={[
              styles.timeChip,

              selectedTime ===
                'today' &&
                styles.timeChipSelected,
            ]}
          >
            <Text
              style={[
                styles.timeChipText,

                selectedTime ===
                  'today' &&
                  styles.timeChipTextSelected,
              ]}
            >
              Oggi
            </Text>
          </Pressable>

          <Pressable
            onPress={() =>
              handleTimeChange(
                'week',
              )
            }
            style={[
              styles.timeChip,

              selectedTime ===
                'week' &&
                styles.timeChipSelected,
            ]}
          >
            <Text
              style={[
                styles.timeChipText,

                selectedTime ===
                  'week' &&
                  styles.timeChipTextSelected,
              ]}
            >
              Settimana
            </Text>
          </Pressable>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={
            false
          }
          contentContainerStyle={
            styles.categoryScroll
          }
        >
          <Pressable
            onPress={() =>
              handleCategoryChange(
                'all',
              )
            }
            style={[
              styles.categoryChip,

              selectedCategory ===
                'all' &&
                styles.categoryChipSelected,
            ]}
          >
            <Text
              style={[
                styles.categoryChipText,

                selectedCategory ===
                  'all' &&
                  styles.categoryChipTextSelected,
              ]}
            >
              Tutti
            </Text>
          </Pressable>

          {(
            Object.keys(
              categoryConfig,
            ) as PlaceCategory[]
          ).map(
            (category) => {
              const config =
                categoryConfig[
                  category
                ];

              const selected =
                selectedCategory ===
                category;

              return (
                <Pressable
                  key={
                    category
                  }
                  onPress={() =>
                    handleCategoryChange(
                      category,
                    )
                  }
                  style={[
                    styles.categoryChip,

                    selected && {
                      backgroundColor:
                        config.color,

                      borderColor:
                        config.color,
                    },
                  ]}
                >
                  <MaterialCommunityIcons
                    name={
                      config.icon
                    }
                    size={16}
                    color={
                      selected
                        ? '#FFFFFF'
                        : config.color
                    }
                  />

                  <Text
                    style={[
                      styles.categoryChipText,

                      selected &&
                        styles.categoryChipTextSelected,
                    ]}
                  >
                    {
                      config.label
                    }
                  </Text>
                </Pressable>
              );
            },
          )}
        </ScrollView>

        <View style={styles.strategyPill}>
          <MaterialCommunityIcons
            name={crowdStrategy === 'hybrid' ? 'transit-connection-variant' : 'signal'}
            size={14}
            color={crowdStrategy === 'hybrid' ? '#0D6D69' : '#4B4B4B'}
          />
          <Text style={styles.strategyPillText}>
            {crowdStrategy === 'hybrid'
              ? 'Hybrid · telemetria + mobilità + eventi + storico'
              : 'Crowd Fusion · BestTime + transazioni + telemetria'}
          </Text>
        </View>

        {loading && (
          <View
            style={
              styles.loadingPill
            }
          >
            <Text
              style={
                styles.loadingText
              }
            >
              Caricamento...
            </Text>
          </View>
        )}

        {!loading && showHeatmap && (
          <View style={styles.heatLegend}>
            <View style={styles.heatLegendScale}>
              <View style={[styles.heatLegendDot, styles.heatLow]} />
              <View style={[styles.heatLegendDot, styles.heatMedium]} />
              <View style={[styles.heatLegendDot, styles.heatHigh]} />
            </View>
            <Text style={styles.heatLegendText}>
              {heatmapLabel}
            </Text>
          </View>
        )}

        {showCrowdUnavailableNotice && (
          <View style={styles.crowdUnavailablePill}>
            <MaterialCommunityIcons name="signal-cellular-outline" size={15} color="#7B5A00" />
            <Text style={styles.crowdUnavailableText}>
              Crowd non disponibile · marker neutri
            </Text>
          </View>
        )}

        {contributionEnabled && (
          <View style={styles.contributionPill}>
            <MaterialCommunityIcons
              name={
                contributionStatus === 'active'
                  ? 'check-circle'
                  : contributionStatus === 'error'
                    ? 'alert-circle-outline'
                    : 'progress-clock'
              }
              size={15}
              color={contributionStatus === 'error' ? '#B44732' : '#217A52'}
            />
            <Text style={styles.contributionText}>
              {contributionStatus === 'active'
                ? `Contributo ricevuto${lastContributionAt ? ` · ${formatCrowdUpdatedAt(lastContributionAt)}` : ''}`
                : contributionStatus === 'error'
                  ? 'Contributo non inviato · riproveremo al prossimo fix'
                  : contributionStatus === 'starting'
                    ? 'Ricerca della posizione in corso'
                    : 'Contributo attivo · in attesa del prossimo invio'}
            </Text>
          </View>
        )}
      </SafeAreaView>

      <Text style={styles.mapAttribution}>© OpenStreetMap contributors</Text>

      <Modal
        animationType="slide"
        transparent
        visible={eventComposerOpen}
        onRequestClose={() => setEventComposerOpen(false)}
      >
        <View style={styles.composerBackdrop}>
          <View style={styles.composerCard}>
            <View style={styles.composerHeader}>
              <View>
                <Text style={styles.composerTitle}>Crea un evento</Text>
                <Text style={styles.composerSubtitle}>La zona è il centro della mappa. Chiudi e sposta la mappa per cambiarla.</Text>
              </View>
              <Pressable onPress={() => setEventComposerOpen(false)} style={styles.closeButton}>
                <MaterialCommunityIcons name="close" size={20} color="#111111" />
              </Pressable>
            </View>

            <TextInput
              value={eventTitle}
              onChangeText={setEventTitle}
              placeholder="Nome dell'evento"
              placeholderTextColor="#9299A1"
              maxLength={90}
              style={styles.composerInput}
            />
            <TextInput
              value={eventDescription}
              onChangeText={setEventDescription}
              placeholder="Descrizione facoltativa"
              placeholderTextColor="#9299A1"
              maxLength={500}
              multiline
              style={[styles.composerInput, styles.composerDescription]}
            />

            <Text style={styles.composerLabel}>Categoria</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.composerCategories}>
              {(Object.keys(categoryConfig) as PlaceCategory[]).map((category) => {
                const active = eventCategory === category;
                const config = categoryConfig[category];
                return (
                  <Pressable
                    key={category}
                    onPress={() => setEventCategory(category)}
                    style={[styles.composerCategory, active && { backgroundColor: config.color, borderColor: config.color }]}
                  >
                    <Text style={[styles.composerCategoryText, active && styles.composerCategoryTextActive]}>{config.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <Text style={styles.composerLabel}>Partecipanti attesi</Text>
            <TextInput
              value={eventAttendance}
              onChangeText={setEventAttendance}
              keyboardType="number-pad"
              maxLength={4}
              style={styles.composerInput}
            />
            <Text style={styles.composerHint}>Inizia ora e dura 3 ore. Il numero è usato solo per una previsione di zona, non come presenza reale.</Text>

            <Pressable
              disabled={creatingEvent}
              onPress={() => void handleCreateEvent()}
              style={[styles.publishEventButton, creatingEvent && styles.publishEventButtonDisabled]}
            >
              <Text style={styles.publishEventButtonText}>{creatingEvent ? 'Pubblicazione…' : 'Pubblica evento'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {selectedPlace && (
        <View
          style={
            styles.cardContainer
          }
        >
          <View
            style={
              styles.card
            }
          >
            <View
              style={
                styles.cardHeader
              }
            >
              <View
                style={
                  styles.cardTitleContainer
                }
              >
                <Text
                  numberOfLines={
                    1
                  }
                  style={
                    styles.cardTitle
                  }
                >
                  {
                    selectedPlace.name
                  }
                </Text>

                <Text
                  numberOfLines={
                    1
                  }
                  style={
                    styles.cardAddress
                  }
                >
                  {selectedPlace.address ??
                    'Milano'}
                </Text>

                <View
                  style={
                    styles.dataBadge
                  }
                >
                  <View
                    style={[
                      styles.dataBadgeDot,
                      selectedPlace.crowdIsFallback ||
                      selectedPlace.crowdDataState ===
                        'stale'
                        ? styles.dataBadgeDotEstimate
                        : selectedPlace.crowdScore ===
                            null
                          ? styles.dataBadgeDotUnavailable
                          : styles.dataBadgeDotLive,
                    ]}
                  />

                  <Text
                    style={
                      styles.dataBadgeText
                    }
                  >
                    {getCrowdDataLabel(
                      selectedPlace,
                    )}
                  </Text>
                </View>
              </View>

              <Pressable
                onPress={() =>
                  setSelectedPlace(
                    null,
                  )
                }
                style={
                  styles.closeButton
                }
              >
                <MaterialCommunityIcons
                  name="close"
                  size={20}
                  color="#111111"
                />
              </Pressable>
            </View>

            <View
              style={
                styles.cardDivider
              }
            />

            <View
              style={
                styles.cardStats
              }
            >
              <View
                style={
                  styles.stat
                }
              >
                <Text
                  style={
                    styles.statLabel
                  }
                >
                  Attività
                </Text>

                <Text
                  style={
                    styles.statValue
                  }
                >
                  {getActivityLabel(
                    selectedPlace.activityLevel,
                  )}
                </Text>
              </View>

              <View
                style={
                  styles.stat
                }
              >
                <Text
                  style={
                    styles.statLabel
                  }
                >
                  Crowd
                </Text>

                <Text
                  style={
                    styles.statValue
                  }
                >
                  {selectedPlace.crowdScore !==
                  null
                    ? `${selectedPlace.crowdScore}/100`
                    : '—'}
                </Text>
              </View>

              <View
                style={
                  styles.stat
                }
              >
                <Text
                  style={
                    styles.statLabel
                  }
                >
                  Trend
                </Text>

                <View
                  style={
                    styles.trendRow
                  }
                >
                  <MaterialCommunityIcons
                    name={getTrendIcon(
                      selectedPlace.trend,
                    )}
                    size={17}
                    color="#111111"
                  />

                  <Text
                    style={
                      styles.statValue
                    }
                  >
                    {getTrendLabel(
                      selectedPlace.trend,
                    )}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.crowdForecastSection}>
              <View style={styles.crowdForecastHeader}>
                <MaterialCommunityIcons
                  name="clock-fast"
                  size={15}
                  color="#666666"
                />
                <Text style={styles.crowdForecastTitle}>
                  Previsione prossime ore
                </Text>
              </View>

              {selectedPlace.crowdForecast.length > 0 ? (
                <View style={styles.crowdForecastRow}>
                  {selectedPlace.crowdForecast.map((forecast) => (
                    <View key={forecast.time} style={styles.crowdForecastSlot}>
                      <Text style={styles.crowdForecastTime}>{forecast.time}</Text>
                      <Text style={styles.crowdForecastScore}>{forecast.score}/100</Text>
                      <Text style={styles.crowdForecastConfidence}>
                        {getForecastConfidenceLabel(forecast.confidence)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.crowdForecastEmpty}>
                  In costruzione: richiede almeno 12 osservazioni reali su 3 giorni per fascia oraria.
                </Text>
              )}
            </View>

            <View style={styles.crowdProvenanceRow}>
              <MaterialCommunityIcons
                name={
                  selectedPlace.crowdDataState === 'unavailable'
                    ? 'information-outline'
                    : selectedPlace.crowdIsFallback ||
                        selectedPlace.crowdDataState === 'fallback'
                      ? 'chart-timeline-variant'
                      : 'check-decagram-outline'
                }
                size={15}
                color="#666666"
              />
              <View style={styles.crowdProvenanceTextWrap}>
                <Text style={styles.crowdProvenanceText}>
                  {getCrowdProvenance(selectedPlace)}
                </Text>
                {selectedPlace.crowdUpdatedAt && (
                  <Text style={styles.crowdProvenanceTime}>
                    Aggiornato alle {formatCrowdUpdatedAt(selectedPlace.crowdUpdatedAt)}
                  </Text>
                )}
              </View>
            </View>
          </View>
        </View>
      )}

      {selectedEvent && (
        <View
          style={
            styles.cardContainer
          }
        >
          <View
            style={[
              styles.card,
              styles.eventCard,
            ]}
          >
            <View
              style={
                styles.eventCardLabelRow
              }
            >
              <View
                style={
                  styles.eventCardLabel
                }
              >
                <MaterialCommunityIcons
                  name="calendar-star"
                  size={14}
                  color="#FFFFFF"
                />

                <Text
                  style={
                    styles.eventCardLabelText
                  }
                >
                  EVENTO LIVE
                </Text>
              </View>

              <Pressable
                onPress={() =>
                  setSelectedEvent(
                    null,
                  )
                }
                style={
                  styles.closeButton
                }
              >
                <MaterialCommunityIcons
                  name="close"
                  size={20}
                  color="#111111"
                />
              </Pressable>
            </View>

            <Text
              style={
                styles.cardTitle
              }
            >
              {
                selectedEvent.title
              }
            </Text>

            <View
              style={
                styles.eventLocationRow
              }
            >
              <MaterialCommunityIcons
                name="map-marker-outline"
                size={17}
                color="#666666"
              />

              <Text
                numberOfLines={
                  2
                }
                style={
                  styles.eventLocationText
                }
              >
                {selectedEvent.venueName ??
                  selectedEvent.address ??
                  'Milano'}
              </Text>
            </View>

            {selectedEvent.description && (
              <Text
                numberOfLines={
                  3
                }
                style={
                  styles.eventDescription
                }
              >
                {
                  selectedEvent.description
                }
              </Text>
            )}

            {selectedEvent.source === 'community' && (
              <View style={styles.eventForecastNotice}>
                <MaterialCommunityIcons name="chart-timeline-variant" size={17} color="#2763B5" />
                <Text style={styles.eventForecastNoticeText}>
                  Previsione dichiarata: {selectedEvent.expectedAttendance ?? '—'} partecipanti attesi. Non è foot traffic verificato.
                </Text>
              </View>
            )}

            <View
              style={
                styles.cardDivider
              }
            />

            <View
              style={
                styles.eventSchedule
              }
            >
              <View
                style={
                  styles.eventScheduleRow
                }
              >
                <MaterialCommunityIcons
                  name="clock-start"
                  size={18}
                  color="#111111"
                />

                <View
                  style={
                    styles.eventScheduleTextContainer
                  }
                >
                  <Text
                    style={
                      styles.statLabel
                    }
                  >
                    Inizio
                  </Text>

                  <Text
                    style={
                      styles.statValue
                    }
                  >
                    {formatEventDateTime(
                      selectedEvent.startAt,
                    )}
                  </Text>
                </View>
              </View>

              <View
                style={
                  styles.eventScheduleRow
                }
              >
                <MaterialCommunityIcons
                  name="clock-end"
                  size={18}
                  color="#111111"
                />

                <View
                  style={
                    styles.eventScheduleTextContainer
                  }
                >
                  <Text
                    style={
                      styles.statLabel
                    }
                  >
                    Fine
                  </Text>

                  <Text
                    style={
                      styles.statValue
                    }
                  >
                    {formatEventDateTime(
                      selectedEvent.endAt,
                    )}
                  </Text>
                </View>
              </View>
            </View>

            <View
              style={
                styles.eventCategoryRow
              }
            >
              <View
                style={[
                  styles.eventCategoryDot,

                  {
                    backgroundColor:
                      categoryConfig[
                        selectedEvent.category
                      ].color,
                  },
                ]}
              />

              <Text
                style={
                  styles.eventCategoryText
                }
              >
                {
                  categoryConfig[
                    selectedEvent.category
                  ].label
                }
              </Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

export default function HomeScreen() {
  return <LiveCityMapScreen crowdStrategy="besttime" />;
}

/* =========================================================
   STYLES
========================================================= */

const styles =
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor:
        '#F5F5F5',
    },

    safeArea: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
    },

    topRow: {
      flexDirection:
        'row',
      alignItems:
        'center',
      justifyContent:
        'space-between',
      paddingHorizontal:
        16,
      paddingTop: 6,
    },

    cityPill: {
      height: 44,
      paddingHorizontal:
        15,
      borderRadius:
        22,
      backgroundColor:
        '#FFFFFF',
      flexDirection:
        'row',
      alignItems:
        'center',
      gap: 6,
      shadowColor:
        '#000000',
      shadowOpacity:
        0.08,
      shadowRadius:
        10,
      shadowOffset: {
        width: 0,
        height: 3,
      },
      elevation: 3,
    },

    cityText: {
      fontSize: 16,
      fontWeight:
        '700',
      color: '#111111',
    },

    topActions: {
      flexDirection:
        'row',
      gap: 8,
    },

    iconButton: {
      width: 44,
      height: 44,
      borderRadius:
        22,
      backgroundColor:
        '#FFFFFF',
      alignItems:
        'center',
      justifyContent:
        'center',
      shadowColor:
        '#000000',
      shadowOpacity:
        0.08,
      shadowRadius:
        10,
      shadowOffset: {
        width: 0,
        height: 3,
      },
      elevation: 3,
    },

    iconButtonActive: {
      backgroundColor: '#111111',
    },

    locationButtonActive: {
      backgroundColor: '#208AEF',
    },

    timeRow: {
      flexDirection:
        'row',
      paddingHorizontal:
        16,
      marginTop: 10,
      gap: 8,
    },

    timeChip: {
      paddingHorizontal:
        16,
      height: 38,
      borderRadius:
        19,
      alignItems:
        'center',
      justifyContent:
        'center',
      backgroundColor:
        '#FFFFFF',
      borderWidth: 1,
      borderColor:
        '#E8E8E8',
    },

    timeChipSelected: {
      backgroundColor:
        '#111111',
      borderColor:
        '#111111',
    },

    timeChipText: {
      color: '#333333',
      fontSize: 14,
      fontWeight:
        '600',
    },

    timeChipTextSelected: {
      color: '#FFFFFF',
    },

    categoryScroll: {
      paddingHorizontal:
        16,
      paddingTop: 10,
      paddingBottom: 8,
      gap: 8,
    },

    categoryChip: {
      height: 38,
      borderRadius:
        19,
      paddingHorizontal:
        14,
      backgroundColor:
        '#FFFFFF',
      borderWidth: 1,
      borderColor:
        '#E8E8E8',
      flexDirection:
        'row',
      alignItems:
        'center',
      gap: 6,
    },

    categoryChipSelected: {
      backgroundColor:
        '#111111',
      borderColor:
        '#111111',
    },

    categoryChipText: {
      color: '#333333',
      fontSize: 13,
      fontWeight:
        '600',
    },

    categoryChipTextSelected: {
      color: '#FFFFFF',
    },

    loadingPill: {
      alignSelf:
        'center',
      marginTop: 4,
      paddingHorizontal:
        14,
      paddingVertical:
        8,
      borderRadius:
        18,
      backgroundColor:
        '#FFFFFF',
    },

    strategyPill: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginHorizontal: 16,
      marginTop: 2,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: 14,
      backgroundColor: 'rgba(255, 255, 255, 0.94)',
      shadowColor: '#000000',
      shadowOpacity: 0.07,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 2,
    },

    strategyPillText: {
      color: '#35424A',
      fontSize: 10,
      fontWeight: '800',
    },

    loadingText: {
      fontSize: 12,
      fontWeight:
        '600',
      color: '#555555',
    },

    heatLegend: {
      alignSelf: 'flex-start',
      marginLeft: 16,
      marginTop: 4,
      height: 30,
      paddingHorizontal: 10,
      borderRadius: 15,
      backgroundColor: 'rgba(255, 255, 255, 0.94)',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },

    heatLegendScale: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
    },

    heatLegendDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
    },

    heatLow: {
      backgroundColor: '#FFD84A',
    },

    heatMedium: {
      backgroundColor: '#FF7A2F',
    },

    heatHigh: {
      backgroundColor: '#8C4DCE',
    },

    heatLegendText: {
      color: '#333333',
      fontSize: 11,
      fontWeight: '700',
    },

    contributionPill: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      marginTop: 8,
      marginHorizontal: 16,
      paddingHorizontal: 11,
      paddingVertical: 8,
      borderRadius: 14,
      backgroundColor: 'rgba(255, 255, 255, 0.94)',
      shadowColor: '#000000',
      shadowOpacity: 0.1,
      shadowRadius: 7,
      shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    },

    crowdUnavailablePill: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      marginTop: 8,
      marginHorizontal: 16,
      paddingHorizontal: 11,
      paddingVertical: 8,
      borderRadius: 14,
      backgroundColor: 'rgba(255, 248, 228, 0.96)',
      shadowColor: '#000000',
      shadowOpacity: 0.08,
      shadowRadius: 7,
      shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    },

    crowdUnavailableText: {
      color: '#6E5100',
      fontSize: 11,
      fontWeight: '700',
    },

    contributionText: {
      color: '#385047',
      fontSize: 11,
      fontWeight: '700',
    },

    mapAttribution: {
      position: 'absolute',
      right: 7,
      bottom: 5,
      color: '#555555',
      fontSize: 9,
      backgroundColor: 'rgba(255, 255, 255, 0.75)',
      paddingHorizontal: 4,
      paddingVertical: 2,
      borderRadius: 3,
    },

    marker: {
      alignItems:
        'center',
      justifyContent:
        'center',
      borderWidth: 2,
      borderColor:
        '#FFFFFF',
      shadowColor:
        '#000000',
      shadowOpacity:
        0.18,
      shadowRadius: 5,
      shadowOffset: {
        width: 0,
        height: 2,
      },
      elevation: 4,
    },

    eventMarker: {
      width: 48,
      height: 48,
      borderRadius:
        24,
      alignItems:
        'center',
      justifyContent:
        'center',
      backgroundColor:
        '#111111',
      borderWidth: 3,
      borderColor:
        '#FFFFFF',
      shadowColor:
        '#000000',
      shadowOpacity:
        0.3,
      shadowRadius: 7,
      shadowOffset: {
        width: 0,
        height: 3,
      },
      elevation: 8,
    },

    eventMarkerBadge: {
      position:
        'absolute',
      top: 1,
      right: 1,
      width: 13,
      height: 13,
      borderRadius:
        7,
      borderWidth: 2,
      borderColor:
        '#FFFFFF',
    },

    composerBackdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0, 0, 0, 0.32)',
    },

    composerCard: {
      backgroundColor: '#FFFFFF',
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      padding: 20,
      paddingBottom: 34,
      gap: 11,
    },

    composerHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: 12,
      alignItems: 'flex-start',
    },

    composerTitle: {
      color: '#111111',
      fontSize: 21,
      fontWeight: '800',
    },

    composerSubtitle: {
      color: '#68717B',
      fontSize: 12,
      lineHeight: 17,
      marginTop: 3,
      maxWidth: 285,
    },

    composerInput: {
      minHeight: 46,
      borderWidth: 1,
      borderColor: '#E2E5E8',
      borderRadius: 13,
      paddingHorizontal: 13,
      color: '#1A1A1A',
      fontSize: 14,
      backgroundColor: '#FAFBFC',
    },

    composerDescription: {
      minHeight: 68,
      paddingTop: 12,
      textAlignVertical: 'top',
    },

    composerLabel: {
      color: '#333333',
      fontSize: 13,
      fontWeight: '800',
      marginTop: 2,
    },

    composerCategories: {
      gap: 7,
      paddingRight: 12,
    },

    composerCategory: {
      borderWidth: 1,
      borderColor: '#E2E5E8',
      borderRadius: 16,
      paddingHorizontal: 12,
      height: 32,
      justifyContent: 'center',
      backgroundColor: '#FFFFFF',
    },

    composerCategoryText: {
      color: '#4F5861',
      fontSize: 12,
      fontWeight: '700',
    },

    composerCategoryTextActive: {
      color: '#FFFFFF',
    },

    composerHint: {
      color: '#69727B',
      fontSize: 11,
      lineHeight: 16,
      marginTop: -3,
    },

    publishEventButton: {
      height: 48,
      borderRadius: 15,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: '#111111',
      marginTop: 3,
    },

    publishEventButtonDisabled: {
      opacity: 0.55,
    },

    publishEventButtonText: {
      color: '#FFFFFF',
      fontSize: 15,
      fontWeight: '800',
    },

    eventForecastNotice: {
      flexDirection: 'row',
      gap: 8,
      backgroundColor: '#EEF5FF',
      borderRadius: 13,
      padding: 10,
      alignItems: 'flex-start',
    },

    eventForecastNoticeText: {
      flex: 1,
      color: '#31506F',
      fontSize: 12,
      lineHeight: 17,
      fontWeight: '600',
    },

    cardContainer: {
      position:
        'absolute',
      left: 14,
      right: 14,
      bottom: 92,
    },

    card: {
      backgroundColor:
        '#FFFFFF',
      borderRadius: 24,
      padding: 18,
      shadowColor:
        '#000000',
      shadowOpacity:
        0.14,
      shadowRadius: 20,
      shadowOffset: {
        width: 0,
        height: 8,
      },
      elevation: 8,
    },

    cardHeader: {
      flexDirection:
        'row',
      alignItems:
        'flex-start',
      justifyContent:
        'space-between',
    },

    cardTitleContainer: {
      flex: 1,
      paddingRight: 12,
    },

    cardTitle: {
      fontSize: 20,
      fontWeight:
        '800',
      color: '#111111',
    },

    cardAddress: {
      marginTop: 4,
      fontSize: 13,
      color: '#777777',
    },

    dataBadge: {
      alignSelf:
        'flex-start',
      flexDirection:
        'row',
      alignItems:
        'center',
      gap: 6,
      marginTop: 9,
      paddingHorizontal:
        9,
      height: 24,
      borderRadius: 12,
      backgroundColor:
        '#F4F4F4',
    },

    dataBadgeDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
    },

    dataBadgeDotLive: {
      backgroundColor:
        '#35A86B',
    },

    dataBadgeDotEstimate: {
      backgroundColor:
        '#E6A23C',
    },

    dataBadgeDotUnavailable: {
      backgroundColor:
        '#AAAAAA',
    },

    dataBadgeText: {
      color: '#555555',
      fontSize: 11,
      fontWeight:
        '700',
    },

    closeButton: {
      width: 34,
      height: 34,
      borderRadius:
        17,
      backgroundColor:
        '#F3F3F3',
      alignItems:
        'center',
      justifyContent:
        'center',
    },

    cardDivider: {
      height: 1,
      backgroundColor:
        '#EEEEEE',
      marginVertical:
        16,
    },

    cardStats: {
      flexDirection:
        'row',
      justifyContent:
        'space-between',
      gap: 12,
    },

    stat: {
      flex: 1,
    },

    statLabel: {
      fontSize: 11,
      textTransform:
        'uppercase',
      letterSpacing:
        0.5,
      color: '#999999',
      fontWeight:
        '700',
      marginBottom: 5,
    },

    statValue: {
      fontSize: 13,
      color: '#111111',
      fontWeight:
        '700',
    },

    trendRow: {
      flexDirection:
        'row',
      alignItems:
        'center',
      gap: 4,
    },

    crowdForecastSection: {
      marginTop: 16,
      paddingTop: 13,
      borderTopWidth: 1,
      borderTopColor: '#F0F0F0',
    },

    crowdForecastHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 10,
    },

    crowdForecastTitle: {
      color: '#555555',
      fontSize: 11,
      fontWeight: '800',
      textTransform: 'uppercase',
      letterSpacing: 0.35,
    },

    crowdForecastRow: {
      flexDirection: 'row',
      gap: 8,
    },

    crowdForecastSlot: {
      flex: 1,
      minWidth: 0,
      backgroundColor: '#F7F7F7',
      borderRadius: 12,
      paddingVertical: 8,
      paddingHorizontal: 7,
    },

    crowdForecastTime: {
      color: '#777777',
      fontSize: 10,
      fontWeight: '700',
    },

    crowdForecastScore: {
      color: '#111111',
      fontSize: 14,
      fontWeight: '800',
      marginTop: 3,
    },

    crowdForecastConfidence: {
      color: '#888888',
      fontSize: 9,
      fontWeight: '600',
      marginTop: 2,
    },

    crowdForecastEmpty: {
      color: '#777777',
      fontSize: 11,
      lineHeight: 16,
    },

    crowdProvenanceRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 7,
      marginTop: 16,
      paddingTop: 13,
      borderTopWidth: 1,
      borderTopColor: '#F0F0F0',
    },

    crowdProvenanceTextWrap: {
      flex: 1,
    },

    crowdProvenanceText: {
      color: '#555555',
      fontSize: 11,
      fontWeight: '700',
    },

    crowdProvenanceTime: {
      color: '#999999',
      fontSize: 10,
      marginTop: 3,
    },

    eventCard: {
      borderTopWidth: 4,
      borderTopColor:
        '#111111',
    },

    eventCardLabelRow: {
      flexDirection:
        'row',
      alignItems:
        'center',
      justifyContent:
        'space-between',
      marginBottom: 10,
    },

    eventCardLabel: {
      height: 28,
      paddingHorizontal:
        10,
      borderRadius:
        14,
      backgroundColor:
        '#111111',
      flexDirection:
        'row',
      alignItems:
        'center',
      gap: 5,
    },

    eventCardLabelText: {
      color: '#FFFFFF',
      fontSize: 10,
      fontWeight:
        '800',
      letterSpacing:
        0.6,
    },

    eventLocationRow: {
      flexDirection:
        'row',
      alignItems:
        'center',
      marginTop: 7,
      gap: 4,
    },

    eventLocationText: {
      flex: 1,
      color: '#666666',
      fontSize: 13,
      fontWeight:
        '600',
    },

    eventDescription: {
      marginTop: 12,
      color: '#555555',
      fontSize: 13,
      lineHeight: 19,
    },

    eventSchedule: {
      gap: 13,
    },

    eventScheduleRow: {
      flexDirection:
        'row',
      alignItems:
        'center',
      gap: 10,
    },

    eventScheduleTextContainer: {
      flex: 1,
    },

    eventCategoryRow: {
      flexDirection:
        'row',
      alignItems:
        'center',
      alignSelf:
        'flex-start',
      marginTop: 16,
      paddingHorizontal:
        10,
      paddingVertical:
        6,
      borderRadius:
        14,
      backgroundColor:
        '#F5F5F5',
      gap: 6,
    },

    eventCategoryDot: {
      width: 8,
      height: 8,
      borderRadius:
        4,
    },

    eventCategoryText: {
      color: '#333333',
      fontSize: 12,
      fontWeight:
        '700',
    },
  });
