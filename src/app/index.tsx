import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

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
  crowdUpdatedAt: string | null;
  crowdValidUntil: string | null;
  crowdIsFallback: boolean;
  crowdDataState: CrowdDataState;
  signalCount: number;
  catalogSource: string | null;
};

type HeatCell = {
  id: string;
  latitude: number;
  longitude: number;
  score: number;
  radius: number;
  hasLiveSignal: boolean;
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

const SUPABASE_LOCATION_INGEST_URL =
  'https://qmskozzidachccwbtejd.supabase.co/functions/v1/location-ingest';

/* =========================================================
   MAP
========================================================= */

const MILAN_REGION = {
  latitude: 45.469,
  longitude: 9.188,
  latitudeDelta: 0.085,
  longitudeDelta: 0.085,
};

const LOCATION_MIN_SEND_INTERVAL_MS = 5 * 60 * 1000;
const LOCATION_MIN_DISTANCE_METERS = 100;
const LOCATION_MAX_ACCURACY_METERS = 250;
const HEAT_GRID_DEGREES = 0.004;
const MAX_HEAT_CELLS = 90;
const CLIENT_REFRESH_INTERVAL_MS = 20 * 60 * 1000;
const MILAN_BOUNDS = {
  south: 45.35,
  north: 45.58,
  west: 8.98,
  east: 9.35,
};

/* =========================================================
   HELPERS
========================================================= */

function getMarkerSize(
  activityLevel: ActivityLevel | null,
) {
  switch (activityLevel) {
    case 'very_high':
      return 68;

    case 'high':
      return 50;

    case 'medium':
      return 36;

    case 'low':
      return 24;

    default:
      return 30;
  }
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

  if (
    place.crowdIsFallback ||
    place.crowdDataState ===
      'fallback' ||
    place.crowdDataState ===
      'stale'
  ) {
    return 'Stima';
  }

  return 'Dato live';
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

function distanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
) {
  const radians = (degrees: number) =>
    (degrees * Math.PI) / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function heatColor(score: number, alpha: number) {
  if (score >= 75) return `rgba(225, 40, 55, ${alpha})`;
  if (score >= 55) return `rgba(255, 112, 45, ${alpha})`;
  if (score >= 35) return `rgba(255, 190, 45, ${alpha})`;
  return `rgba(63, 174, 98, ${alpha})`;
}

function heatLabel(hasLiveData: boolean) {
  return hasLiveData
    ? 'Affollamento territoriale · live + stime'
    : 'Affollamento territoriale · stime';
}

/* =========================================================
   SCREEN
========================================================= */

export default function HomeScreen() {
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

  const [showHeatmap, setShowHeatmap] =
    useState(true);

  const [contributionEnabled, setContributionEnabled] =
    useState(false);

  const locationSubscriptionRef =
    useRef<Location.LocationSubscription | null>(null);

  const locationSessionIdRef =
    useRef<string | null>(null);

  const lastSentLocationRef =
    useRef<{
      latitude: number;
      longitude: number;
      sentAt: number;
    } | null>(null);

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
          console.error(
            'Supabase publishable key non trovata',
          );

          return;
        }

        console.log(
          'PLACES READ: lettura catalogo da Supabase...',
        );

        const response =
          await fetch(
            SUPABASE_PLACES_READ_URL,
            {
              method: 'GET',

              headers: {
                Authorization:
                  `Bearer ${supabaseKey}`,

                apikey:
                  supabaseKey,
              },
            },
          );

        const data =
          await response.json();

        console.log(
          'PLACES READ STATS:',
          {
            count:
              data.count,

            matchedCount:
              data.matchedCount,

            availableCrowdCount:
              data.availableCrowdCount,

            liveEstimateCount:
              data.liveEstimateCount,

            forecastEstimateCount:
              data.forecastEstimateCount,

            unavailableCrowdCount:
              data.unavailableCrowdCount,
          },
        );

        if (
          !response.ok ||
          !data.success
        ) {
          console.error(
            'PLACES READ ERROR:',
            {
              status:
                response.status,

              response:
                data,
            },
          );

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
              crowdUpdatedAt?: string | null;
              crowdValidUntil?: string | null;
              crowdIsFallback?: boolean;
              crowdDataState?: CrowdDataState;
              signalCount?: number;
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

        console.log(
          `PLACES READ COMPLETATO: ${loadedPlaces.length} places`,
        );

        console.log(
          'CROWD AVAILABLE IN APP:',
          loadedPlaces.filter(
            (place) =>
              place.crowdScore !==
              null,
          ).length,
        );
      } catch (error) {
        if (!cancelled) {
          console.error(
            'PLACES READ ERROR:',
            error,
          );
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
  }, []);

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
          console.error(
            'Supabase publishable key non trovata',
          );

          return;
        }

        console.log(
          'EVENTS READ: caricamento eventi...',
          {
            window:
              selectedTime,

            category:
              selectedCategory,
          },
        );

        const response =
          await fetch(
            SUPABASE_EVENTS_READ_URL,
            {
              method: 'POST',

              headers: {
                Authorization:
                  `Bearer ${supabaseKey}`,

                apikey:
                  supabaseKey,

                'Content-Type':
                  'application/json',
              },

              body:
                JSON.stringify({
                  window:
                    selectedTime,

                  category:
                    selectedCategory,

                  limit:
                    100,
                }),
            },
          );

        const data =
          await response.json();

        if (
          !response.ok ||
          !data.ok
        ) {
          console.error(
            'EVENTS READ ERROR:',
            {
              status:
                response.status,

              response:
                data,
            },
          );

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
            }),
          );

        if (cancelled) {
          return;
        }

        setEvents(
          loadedEvents,
        );

        console.log(
          'EVENTS READ COMPLETATO:',
          {
            count:
              loadedEvents.length,

            window:
              selectedTime,

            category:
              selectedCategory,
          },
        );
      } catch (error) {
        if (!cancelled) {
          console.error(
            'EVENTS READ ERROR:',
            error,
          );
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

  const filteredPlaces =
    useMemo(() => {
      if (
        selectedCategory ===
        'all'
      ) {
        return places;
      }

      return places.filter(
        (place) =>
          place.category ===
          selectedCategory,
      );
  }, [
    places,
    selectedCategory,
  ]);

  const heatCells = useMemo<HeatCell[]>(() => {
    const cells = new Map<
      string,
      {
        latitudeTotal: number;
        longitudeTotal: number;
        scoreTotal: number;
        count: number;
        hasLiveSignal: boolean;
      }
    >();

    for (const place of filteredPlaces) {
      if (place.crowdScore === null) continue;
      const latitudeKey = Math.round(place.latitude / HEAT_GRID_DEGREES);
      const longitudeKey = Math.round(place.longitude / HEAT_GRID_DEGREES);
      const id = `${latitudeKey}:${longitudeKey}`;
      const cell = cells.get(id) ?? {
        latitudeTotal: 0,
        longitudeTotal: 0,
        scoreTotal: 0,
        count: 0,
        hasLiveSignal: false,
      };
      cell.latitudeTotal += place.latitude;
      cell.longitudeTotal += place.longitude;
      cell.scoreTotal += place.crowdScore;
      cell.count += 1;
      cell.hasLiveSignal ||=
        place.crowdDataState === 'fresh' && !place.crowdIsFallback;
      cells.set(id, cell);
    }

    return [...cells.entries()]
      .map(([id, cell]) => ({
        id,
        latitude: cell.latitudeTotal / cell.count,
        longitude: cell.longitudeTotal / cell.count,
        score: Math.round(cell.scoreTotal / cell.count),
        radius: Math.min(430, 190 + cell.count * 45),
        hasLiveSignal: cell.hasLiveSignal,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_HEAT_CELLS);
  }, [filteredPlaces]);

  const heatmapHasLiveData = heatCells.some(
    (cell) => cell.hasLiveSignal,
  );

  const stopLocationContribution = () => {
    locationSubscriptionRef.current?.remove();
    locationSubscriptionRef.current = null;
    lastSentLocationRef.current = null;
    locationSessionIdRef.current = null;
    setContributionEnabled(false);
  };

  const sendLocationObservation = async (
    location: Location.LocationObject,
  ) => {
    const accuracy = location.coords.accuracy;
    if (accuracy !== null && accuracy > LOCATION_MAX_ACCURACY_METERS) return;

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
      return;
    }
    const previous = lastSentLocationRef.current;
    if (
      previous &&
      now - previous.sentAt < LOCATION_MIN_SEND_INTERVAL_MS &&
      distanceMeters(previous, nextPoint) < LOCATION_MIN_DISTANCE_METERS
    ) {
      return;
    }

    const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const sessionId = locationSessionIdRef.current;
    if (!supabaseKey || !sessionId) return;

    const response = await fetch(SUPABASE_LOCATION_INGEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        apikey: supabaseKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId,
        latitude: nextPoint.latitude,
        longitude: nextPoint.longitude,
        accuracyMeters: accuracy,
        observedAt: new Date(location.timestamp).toISOString(),
      }),
    });

    if (!response.ok) {
      console.warn('LOCATION INGEST ERROR:', response.status);
      return;
    }

    lastSentLocationRef.current = { ...nextPoint, sentAt: now };
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
    locationSubscriptionRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Balanced,
        distanceInterval: LOCATION_MIN_DISTANCE_METERS,
        timeInterval: LOCATION_MIN_SEND_INTERVAL_MS,
      },
      (location) => {
        void sendLocationObservation(location).catch((error) =>
          console.warn('LOCATION INGEST ERROR:', error),
        );
      },
    );
    setContributionEnabled(true);
  };

  const handleContributionPress = () => {
    if (contributionEnabled) {
      stopLocationContribution();
      return;
    }

    Alert.alert(
      'Contribuisci alla mappa live?',
      'Se accetti, LIVE CITY usa la posizione solo mentre l’app è aperta. Invia un identificatore casuale di sessione, non il tuo nome. I punti grezzi vengono eliminati entro 24 ore e diventano visibili solo come dati aggregati di almeno 5 persone.',
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

  /* =======================================================
     RENDER
  ======================================================= */

  return (
    <View style={styles.container}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={MILAN_REGION}
        showsUserLocation={contributionEnabled}
        showsMyLocationButton={false}
      >
        {showHeatmap &&
          heatCells.map((cell) => (
            <Circle
              key={`heat-outer-${cell.id}`}
              center={{ latitude: cell.latitude, longitude: cell.longitude }}
              radius={cell.radius}
              fillColor={heatColor(cell.score, 0.3)}
              strokeColor={heatColor(cell.score, 0.48)}
              strokeWidth={2}
              zIndex={5}
            />
          ))}

        {showHeatmap &&
          heatCells.map((cell) => (
            <Circle
              key={`heat-inner-${cell.id}`}
              center={{ latitude: cell.latitude, longitude: cell.longitude }}
              radius={cell.radius * 0.48}
              fillColor={heatColor(cell.score, 0.62)}
              strokeColor="transparent"
              zIndex={6}
            />
          ))}

        {filteredPlaces.map(
          (place) => {
            const config =
              categoryConfig[
                place.category
              ];

            const markerSize =
              getMarkerSize(
                place.activityLevel,
              );

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

        {events.map(
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
              accessibilityLabel="Mostra o nascondi la superficie di affollamento"
              onPress={() => setShowHeatmap((value) => !value)}
              style={[styles.iconButton, showHeatmap && styles.iconButtonActive]}
            >
              <MaterialCommunityIcons
                name="blur"
                size={22}
                color={showHeatmap ? '#FFFFFF' : '#111111'}
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
              {heatLabel(heatmapHasLiveData)}
            </Text>
          </View>
        )}
      </SafeAreaView>

      <Text style={styles.mapAttribution}>© OpenStreetMap contributors</Text>

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
      backgroundColor: '#3FAE62',
    },

    heatMedium: {
      backgroundColor: '#FFBE2D',
    },

    heatHigh: {
      backgroundColor: '#E12837',
    },

    heatLegendText: {
      color: '#333333',
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
