import {
  cellLatitude,
  cellLongitude,
  createEmptyGrid,
  METERS_PER_DEGREE_LATITUDE,
  metersPerDegreeLongitude,
  ZONE_ACTIVITIES,
  type CrowdGrid,
  type GridBounds,
  type ZoneActivity,
} from './crowd-grid';

/**
 * Fictional real-time crowd field for central Milan.
 *
 * NOT REAL DATA. It exists so the focus-zone pipeline (peaks, isolines, names,
 * activity filter) can be designed before the backend produces a dense field.
 * It must only be rendered behind EXPO_PUBLIC_ENABLE_DEMO_HEATMAP=true.
 *
 * The field models people outdoors only: every source is a public space
 * (square, canal bank, park, nightlife street) or a pedestrian corridor, so
 * residential blocks stay at zero by construction. Each source follows a daily
 * profile for its activity, so the map changes with the time of day.
 */

type Hotspot = {
  activity: ZoneActivity;
  latitude: number;
  longitude: number;
  /** Relative strength at the activity's peak hour, 0–1. */
  weight: number;
  /** Spread along the main axis, meters. */
  alongMeters: number;
  /** Spread across the main axis, meters. */
  acrossMeters: number;
  /** Direction of the main axis, degrees counter-clockwise from east. */
  angle: number;
};

type Corridor = {
  from: [latitude: number, longitude: number];
  to: [latitude: number, longitude: number];
  weight: number;
};

const h = (
  activity: ZoneActivity,
  latitude: number,
  longitude: number,
  weight: number,
  alongMeters: number,
  acrossMeters: number,
  angle = 0,
): Hotspot => ({ activity, latitude, longitude, weight, alongMeters, acrossMeters, angle });

const HOTSPOTS: readonly Hotspot[] = [
  h('aperitivo', 45.4527, 9.1791, 1, 170, 110, 10), // Darsena
  h('aperitivo', 45.4508, 9.1715, 0.85, 330, 70, 23), // Naviglio Grande
  h('aperitivo', 45.4475, 9.1778, 0.55, 260, 60, 95), // Naviglio Pavese
  h('aperitivo', 45.4583, 9.1813, 0.9, 120, 90), // Colonne di San Lorenzo
  h('aperitivo', 45.4773, 9.1857, 0.75, 250, 80, 74), // Corso Garibaldi
  h('aperitivo', 45.479, 9.205, 0.8, 200, 150, 30), // Lazzaretto
  h('aperitivo', 45.4886, 9.1905, 0.6, 180, 90, 80), // Isola
  h('aperitivo', 45.4775, 9.17, 0.65, 230, 90, 60), // Arco della Pace
  h('aperitivo', 45.4988, 9.2192, 0.45, 160, 120), // NoLo
  h('aperitivo', 45.4512, 9.2022, 0.45, 150, 110, 30), // Porta Romana

  h('food', 45.4719, 9.1878, 0.85, 200, 150, 70), // Brera
  h('food', 45.4799, 9.1762, 0.7, 260, 80, 140), // Chinatown
  h('food', 45.476, 9.208, 0.65, 180, 130, 30), // Porta Venezia
  h('food', 45.4492, 9.1745, 0.6, 200, 90, 23), // Navigli
  h('food', 45.488, 9.1925, 0.5, 150, 120), // Isola
  h('food', 45.4548, 9.1628, 0.45, 180, 110), // Tortona

  h('nightlife', 45.4822, 9.1878, 0.95, 160, 90, 80), // Corso Como
  h('nightlife', 45.456, 9.1815, 0.75, 220, 90, 95), // Ticinese
  h('nightlife', 45.4515, 9.1745, 0.8, 260, 80, 23), // Navigli
  h('nightlife', 45.4778, 9.2072, 0.7, 170, 120, 40), // Porta Venezia
  h('nightlife', 45.4765, 9.1715, 0.6, 180, 110, 60), // Arco della Pace
  h('nightlife', 45.489, 9.1885, 0.5, 140, 100), // Isola

  h('outdoor', 45.4728, 9.1752, 0.85, 380, 240, 134), // Parco Sempione
  h('outdoor', 45.4838, 9.1915, 0.7, 220, 150, 10), // Biblioteca degli Alberi
  h('outdoor', 45.4527, 9.1791, 0.6, 150, 110), // Darsena
  h('outdoor', 45.4737, 9.2005, 0.5, 220, 160, 45), // Giardini Montanelli
  h('outdoor', 45.4777, 9.1553, 0.45, 220, 160), // CityLife

  h('culture', 45.4641, 9.1919, 1, 170, 140), // Piazza Duomo
  h('culture', 45.4659, 9.19, 0.8, 90, 70, 90), // Galleria
  h('culture', 45.4652, 9.196, 0.75, 260, 60, 22), // Corso Vittorio Emanuele
  h('culture', 45.4705, 9.1795, 0.65, 160, 130), // Castello Sforzesco
  h('culture', 45.4612, 9.1858, 0.55, 300, 60, 50), // Via Torino
  h('culture', 45.4719, 9.188, 0.4, 120, 100), // Pinacoteca di Brera
  h('culture', 45.4447, 9.2044, 0.35, 120, 100), // Fondazione Prada
];

/** Daytime pedestrian flows: people walking, never a focus zone on their own. */
const CORRIDORS: readonly Corridor[] = [
  { from: [45.4775, 9.2058], to: [45.4868, 9.2155], weight: 30 }, // Corso Buenos Aires
  { from: [45.4583, 9.1828], to: [45.4637, 9.1893], weight: 26 }, // Via Torino
  { from: [45.4645, 9.1925], to: [45.4664, 9.1993], weight: 28 }, // Corso Vittorio Emanuele
  { from: [45.4655, 9.1868], to: [45.4693, 9.1825], weight: 22 }, // Via Dante
  { from: [45.474, 9.184], to: [45.4815, 9.187], weight: 18 }, // Corso Garibaldi
];

export const DEMO_FIELD_BOUNDS = {
  south: 45.438,
  north: 45.503,
  west: 9.148,
  east: 9.232,
};

const CELL_SIZE_METERS = 80;
const SPREAD_SCALE = 1.3;
const TEXTURE_STRENGTH = 0.3;
/** Wavelength of the organic texture, meters (independent of grid resolution). */
const TEXTURE_WAVELENGTH_METERS = 360;
const LOBES_PER_HOTSPOT = 3;
/** Peak amplitude at weight 1 and full activity level. */
const HOTSPOT_AMPLITUDE = 120;
/**
 * Share of a hotspot that is diffuse presence across the whole area; the rest
 * is concentrated in small groups. When zoomed in, the groups show where the
 * crowd actually packs, instead of the whole park or square looking full.
 */
const DIFFUSE_SHARE = 0.32;
const GROUPS_PER_HOTSPOT = 7;
const GROUP_AMPLITUDE = 0.7;
const NOISE_BUCKET_MS = 10 * 60 * 1000;
const MILAN_LATITUDE = 45.4642;
const MILAN_LONGITUDE = 9.19;

export type DemoCrowdField = {
  grid: CrowdGrid;
  /** Local Europe/Rome time used for the simulation, fractional hours. */
  localHour: number;
  sunsetHour: number;
};

export type DemoCrowdFieldOptions = {
  hourOverride?: number;
  /** Area to simulate; defaults to the whole centre of Milan. */
  bounds?: GridBounds;
  /** Grid resolution; finer cells reveal the small groups when zoomed in. */
  cellSizeMeters?: number;
};

export function generateDemoCrowdField(
  now: Date,
  options: DemoCrowdFieldOptions = {},
): DemoCrowdField {
  const local = romeLocalTime(now);
  const localHour = options.hourOverride ?? local.hour;
  const sunsetHour = romeSunsetHour(now);
  const noiseBucket = Math.floor(now.getTime() / NOISE_BUCKET_MS);

  const grid = createEmptyGrid(options.bounds ?? DEMO_FIELD_BOUNDS, options.cellSizeMeters ?? CELL_SIZE_METERS);
  const cellCount = grid.rows * grid.cols;
  const rawLayers = Object.fromEntries(
    ZONE_ACTIVITIES.map((activity) => [activity, new Float32Array(cellCount)]),
  ) as Record<ZoneActivity, Float32Array>;
  const rawFlow = new Float32Array(cellCount);

  HOTSPOTS.forEach((hotspot, index) => {
    // ±12% drift every 10 minutes keeps the map alive between refreshes.
    const drift = 0.88 + 0.24 * hash01(index, noiseBucket);
    const level = activityLevel(hotspot.activity, localHour, local.weekday, sunsetHour);
    const amplitude = HOTSPOT_AMPLITUDE * hotspot.weight * level * drift;
    if (amplitude < 1) return;
    const target = rawLayers[hotspot.activity];
    splatGaussian(grid, target, hotspot, amplitude * DIFFUSE_SHARE);
    for (const lobe of lobesFor(hotspot, index)) {
      splatGaussian(grid, target, lobe.hotspot, amplitude * DIFFUSE_SHARE * lobe.weight);
    }
    for (const group of groupsFor(hotspot, index)) {
      splatGaussian(grid, target, group.hotspot, amplitude * GROUP_AMPLITUDE * group.weight, 1);
    }
  });

  const walkingLevel = bump(localHour, 13, 4.5) + 0.6 * bump(localHour, 18.5, 1.5);
  for (const corridor of CORRIDORS) {
    splatCorridor(grid, rawFlow, corridor, corridor.weight * Math.min(walkingLevel, 1));
  }

  // Low-frequency multiplicative noise makes contours organic instead of
  // perfectly elliptical, like real crowds bending around streets.
  const layers: Partial<Record<ZoneActivity, Float32Array>> = {};
  for (const activity of ZONE_ACTIVITIES) layers[activity] = new Float32Array(cellCount);

  const textureMetersX = metersPerDegreeLongitude(grid.originLatitude);
  for (let row = 0; row < grid.rows; row += 1) {
    const noiseY = (cellLatitude(grid, row) * METERS_PER_DEGREE_LATITUDE) / TEXTURE_WAVELENGTH_METERS;
    for (let col = 0; col < grid.cols; col += 1) {
      const index = row * grid.cols + col;
      // Noise in absolute meters: the same texture at every zoom level.
      const noiseX = (cellLongitude(grid, col) * textureMetersX) / TEXTURE_WAVELENGTH_METERS;
      const texture = 1 + TEXTURE_STRENGTH * (valueNoise(noiseY, noiseX, noiseBucket) - 0.5) * 2;
      let total = rawFlow[index];
      for (const activity of ZONE_ACTIVITIES) {
        const raw = rawLayers[activity][index];
        total += raw;
        layers[activity]![index] = softClip(raw * texture);
      }
      grid.values[index] = softClip(total * texture);
    }
  }

  grid.layers = layers;
  return { grid, localHour, sunsetHour };
}

/* ---------------------------------------------------------------------------
   Daily profiles
--------------------------------------------------------------------------- */

/** Relative intensity of an activity at a local hour, roughly 0–1.2. */
export function activityLevel(
  activity: ZoneActivity,
  hour: number,
  weekday: number,
  sunsetHour: number,
): number {
  const friSat = weekday === 5 || weekday === 6;
  const weekend = weekday === 0 || weekday === 6;

  switch (activity) {
    case 'aperitivo':
      return (bump(hour, 19.3, 1.4) + 0.25 * bump(hour, 22.5, 1.2)) * (friSat ? 1.15 : 1);
    case 'food':
      return 0.55 * bump(hour, 13, 0.9) + bump(hour, 21, 1.1);
    case 'nightlife':
      return (bump(hour, 0.8, 1.8) + 0.3 * bump(hour, 22.5, 1)) * (friSat ? 1.3 : 0.75);
    case 'outdoor':
      return 0.55 * bump(hour, 15.5, 2.6) * (weekend ? 1.4 : 1) + 0.75 * bump(hour, sunsetHour - 0.2, 0.7);
    case 'culture':
      return (bump(hour, 15, 3.2) + 0.25 * bump(hour, 11, 1.5)) * (weekend ? 1.25 : 1);
  }
}

/** Gaussian bump on the 24-hour circle. */
function bump(hour: number, center: number, width: number): number {
  let distance = Math.abs(hour - center) % 24;
  if (distance > 12) distance = 24 - distance;
  return Math.exp(-0.5 * (distance / width) ** 2);
}

/** Keeps scores within 0–100 while letting overlapping sources still stand out. */
function softClip(raw: number): number {
  if (raw <= 70) return raw;
  return 70 + 30 * (1 - Math.exp(-(raw - 70) / 30));
}

/* ---------------------------------------------------------------------------
   Splatting
--------------------------------------------------------------------------- */

function splatGaussian(
  grid: CrowdGrid,
  target: Float32Array,
  hotspot: Hotspot,
  amplitude: number,
  spreadScale = SPREAD_SCALE,
) {
  const metersX = metersPerDegreeLongitude(hotspot.latitude);
  const alongMeters = hotspot.alongMeters * spreadScale;
  const acrossMeters = hotspot.acrossMeters * spreadScale;
  const cos = Math.cos((hotspot.angle * Math.PI) / 180);
  const sin = Math.sin((hotspot.angle * Math.PI) / 180);
  const reach = Math.max(alongMeters, acrossMeters) * 3.5;

  const rowMin = Math.max(0, Math.floor((hotspot.latitude - reach / METERS_PER_DEGREE_LATITUDE - grid.originLatitude) / grid.latitudeStep));
  const rowMax = Math.min(grid.rows - 1, Math.ceil((hotspot.latitude + reach / METERS_PER_DEGREE_LATITUDE - grid.originLatitude) / grid.latitudeStep));
  const colMin = Math.max(0, Math.floor((hotspot.longitude - reach / metersX - grid.originLongitude) / grid.longitudeStep));
  const colMax = Math.min(grid.cols - 1, Math.ceil((hotspot.longitude + reach / metersX - grid.originLongitude) / grid.longitudeStep));

  for (let row = rowMin; row <= rowMax; row += 1) {
    const dy = (cellLatitude(grid, row) - hotspot.latitude) * METERS_PER_DEGREE_LATITUDE;
    for (let col = colMin; col <= colMax; col += 1) {
      const dx = (cellLongitude(grid, col) - hotspot.longitude) * metersX;
      const along = dx * cos + dy * sin;
      const across = -dx * sin + dy * cos;
      const exponent = (along / alongMeters) ** 2 + (across / acrossMeters) ** 2;
      if (exponent > 12) continue;
      target[row * grid.cols + col] += amplitude * Math.exp(-0.5 * exponent);
    }
  }
}

/**
 * Smaller satellite crowds around a hotspot (side streets, a nearby bar, the
 * queue at a kiosk). They give each zone irregular lobes, like the bulges of a
 * contour line, instead of a perfect ellipse. Fixed per hotspot, so shapes
 * stay recognisable over time.
 */
function lobesFor(hotspot: Hotspot, index: number): { hotspot: Hotspot; weight: number }[] {
  const metersX = metersPerDegreeLongitude(hotspot.latitude);
  return Array.from({ length: LOBES_PER_HOTSPOT }, (_, lobe) => {
    const angle = hash01(index, 1000 + lobe) * 2 * Math.PI;
    const distance = hotspot.alongMeters * SPREAD_SCALE * (0.8 + 0.8 * hash01(index, 2000 + lobe));
    const size = 0.45 + 0.3 * hash01(index, 3000 + lobe);
    return {
      weight: 0.3 + 0.3 * hash01(index, 4000 + lobe),
      hotspot: {
        ...hotspot,
        latitude: hotspot.latitude + (Math.sin(angle) * distance) / METERS_PER_DEGREE_LATITUDE,
        longitude: hotspot.longitude + (Math.cos(angle) * distance) / metersX,
        alongMeters: hotspot.alongMeters * size,
        acrossMeters: hotspot.acrossMeters * size * 1.4,
        angle: hotspot.angle + 60 * (hash01(index, 5000 + lobe) - 0.5),
      },
    };
  });
}

/**
 * Small groups inside a hotspot, 30–60 m across (the steps of the Arco della
 * Pace, a kiosk, a lawn): the real packed spots of a crowd. Fixed per hotspot.
 */
function groupsFor(hotspot: Hotspot, index: number): { hotspot: Hotspot; weight: number }[] {
  const metersX = metersPerDegreeLongitude(hotspot.latitude);
  const cos = Math.cos((hotspot.angle * Math.PI) / 180);
  const sin = Math.sin((hotspot.angle * Math.PI) / 180);
  return Array.from({ length: GROUPS_PER_HOTSPOT }, (_, group) => {
    const along = (hash01(index, 6000 + group) - 0.5) * 2 * hotspot.alongMeters;
    const across = (hash01(index, 7000 + group) - 0.5) * 2 * hotspot.acrossMeters;
    const radius = 15 + 15 * hash01(index, 8000 + group);
    return {
      weight: 0.6 + 0.4 * hash01(index, 9000 + group),
      hotspot: {
        ...hotspot,
        latitude: hotspot.latitude + (along * sin + across * cos) / METERS_PER_DEGREE_LATITUDE,
        longitude: hotspot.longitude + (along * cos - across * sin) / metersX,
        alongMeters: radius * 1.3,
        acrossMeters: radius,
        angle: 180 * hash01(index, 10000 + group),
      },
    };
  });
}

function splatCorridor(grid: CrowdGrid, target: Float32Array, corridor: Corridor, amplitude: number) {
  if (amplitude < 1) return;
  const [fromLatitude, fromLongitude] = corridor.from;
  const [toLatitude, toLongitude] = corridor.to;
  const metersX = metersPerDegreeLongitude(fromLatitude);
  const length = Math.hypot(
    (toLatitude - fromLatitude) * METERS_PER_DEGREE_LATITUDE,
    (toLongitude - fromLongitude) * metersX,
  );
  const steps = Math.max(1, Math.round(length / 60));
  const angle = (Math.atan2(
    (toLatitude - fromLatitude) * METERS_PER_DEGREE_LATITUDE,
    (toLongitude - fromLongitude) * metersX,
  ) * 180) / Math.PI;

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    splatGaussian(grid, target, {
      activity: 'culture',
      latitude: fromLatitude + (toLatitude - fromLatitude) * t,
      longitude: fromLongitude + (toLongitude - fromLongitude) * t,
      weight: 1,
      alongMeters: 70,
      acrossMeters: 40,
      angle,
    }, amplitude / 5.5);
  }
}

/* ---------------------------------------------------------------------------
   Deterministic noise
--------------------------------------------------------------------------- */

function hash01(a: number, b: number): number {
  let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function valueNoise(y: number, x: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const corner = (cy: number, cx: number) => hash01(cy * 7919 + seed, cx * 104729 - seed);
  const top = corner(y0, x0) * (1 - sx) + corner(y0, x0 + 1) * sx;
  const bottom = corner(y0 + 1, x0) * (1 - sx) + corner(y0 + 1, x0 + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

/* ---------------------------------------------------------------------------
   Time
--------------------------------------------------------------------------- */

const romeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Local Europe/Rome hour (fractional) and weekday (0 = Sunday). */
export function romeLocalTime(date: Date): { hour: number; weekday: number } {
  const parts = romeFormatter.formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    hour: Number(value('hour')) + Number(value('minute')) / 60,
    weekday: Math.max(0, WEEKDAYS.indexOf(value('weekday'))),
  };
}

/** Approximate local sunset in Milan (±15 minutes), fractional hours. */
export function romeSunsetHour(date: Date): number {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86_400_000);
  const declination = (-23.44 * Math.PI / 180) * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  const latitude = (MILAN_LATITUDE * Math.PI) / 180;
  const cosHourAngle = (Math.cos((90.833 * Math.PI) / 180) - Math.sin(latitude) * Math.sin(declination))
    / (Math.cos(latitude) * Math.cos(declination));
  const hourAngle = (Math.acos(Math.min(1, Math.max(-1, cosHourAngle))) * 180) / Math.PI;
  // Equation of time: the solar day drifts up to ±16 minutes during the year.
  const b = (2 * Math.PI / 365) * (dayOfYear - 81);
  const equationOfTimeMinutes = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const sunsetUtcHours = 12 - MILAN_LONGITUDE / 15 - equationOfTimeMinutes / 60 + hourAngle / 15;

  const sunsetUtc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  sunsetUtc.setUTCMinutes(Math.round(sunsetUtcHours * 60));
  return romeLocalTime(sunsetUtc).hour;
}
