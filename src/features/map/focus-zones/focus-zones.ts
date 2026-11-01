import {
  cellLatitude,
  cellLongitude,
  distanceMeters,
  METERS_PER_DEGREE_LATITUDE,
  metersPerDegreeLongitude,
  ZONE_ACTIVITIES,
  type CrowdGrid,
  type ZoneActivity,
} from './crowd-grid';
import { MILAN_LANDMARKS, type Landmark } from './milan-landmarks';

/**
 * Focus zones: the "mountain peaks" of the crowd field.
 *
 * The density grid is read like a topographic map: every cell is the height of
 * the terrain (people on the street). Peaks are local maxima that stand out
 * enough from their surroundings (topographic prominence). Around each focal
 * peak the map draws its isolines only, so the city is not covered by a
 * continuous heatmap: low ground and isolated bumps stay invisible.
 */

export type LatLng = { latitude: number; longitude: number };

/**
 * Isoline levels on the 0–100 density score, outermost first. Three levels
 * keep the map readable for users: busy, very busy, packed.
 */
export const FOCUS_LEVELS = [
  { threshold: 45, color: '#FFD84A' },
  { threshold: 65, color: '#FF7A2F' },
  { threshold: 83, color: '#F1424E' },
] as const;

/** Minimum density for a peak to become a focal point. */
export const MIN_PEAK_SCORE = 56;
/** Score a peak must rise above the saddle joining it to a higher peak. */
export const MIN_PEAK_PROMINENCE = 7;

/**
 * How much detail the zones show. Like a hiking map, contours are generalised
 * when the whole city is on screen and get precise when zoomed in: at street
 * level, packed spots down to ~50 m across become visible.
 */
export type FocusDetail = {
  /** Grid resolution the density field should be sampled at, meters. */
  cellSizeMeters: number;
  /**
   * Radius over which a packed spot lifts its surroundings, meters (a
   * grey-scale dilation). Zoomed out, an area containing a packed spot reads
   * as busy, instead of the spot vanishing into the average.
   */
  peakSpreadMeters: number;
  /**
   * Gaussian blur of the density field before tracing, meters. Outline
   * smoothing alone cannot remove long thin spikes; blurring the terrain
   * rounds them into soft bulges.
   */
  fieldSmoothingMeters: number;
  /** Gaussian smoothing radius along the outline, meters: rounds the corners. */
  outlineSmoothingMeters: number;
  /** Spacing of the output polygon vertices, meters. */
  vertexSpacingMeters: number;
  /** Isolines enclosing less than this are dropped, square meters. */
  minRingAreaSquareMeters: number;
};

export type FocusDetailLevel = 'city' | 'district' | 'street';

export const FOCUS_DETAIL: Record<FocusDetailLevel, FocusDetail> = {
  city: {
    cellSizeMeters: 80,
    peakSpreadMeters: 120,
    fieldSmoothingMeters: 75,
    outlineSmoothingMeters: 60,
    vertexSpacingMeters: 8,
    minRingAreaSquareMeters: 9_600,
  },
  district: {
    cellSizeMeters: 40,
    peakSpreadMeters: 50,
    fieldSmoothingMeters: 40,
    outlineSmoothingMeters: 30,
    vertexSpacingMeters: 5,
    minRingAreaSquareMeters: 3_000,
  },
  street: {
    cellSizeMeters: 20,
    peakSpreadMeters: 0,
    fieldSmoothingMeters: 20,
    outlineSmoothingMeters: 15,
    vertexSpacingMeters: 3,
    minRingAreaSquareMeters: 1_200,
  },
};

/** Detail level for the visible map span (latitude degrees). */
export function focusDetailForZoom(latitudeDelta: number): FocusDetailLevel {
  if (latitudeDelta > 0.04) return 'city';
  if (latitudeDelta > 0.015) return 'district';
  return 'street';
}

const LANDMARK_RADIUS_METERS = 650;
/** A peak this close to a stronger one is a packed spot of the same gathering. */
const SECONDARY_PEAK_RADIUS_METERS = 250;

export type FocusPeak = {
  id: string;
  latitude: number;
  longitude: number;
  score: number;
  prominence: number;
  activity: ZoneActivity | null;
  /** Place name, e.g. "Darsena". */
  name: string;
  /** Type of gathering at this hour, e.g. "Tramonto". */
  label: string;
  /**
   * False for secondary peaks of an already-named place (several packed spots
   * inside Parco Sempione when zoomed in): the map tags only primary peaks.
   */
  isPrimary: boolean;
};

export type FocusContour = {
  id: string;
  levelIndex: number;
  color: string;
  coordinates: LatLng[];
  holes: LatLng[][];
  /** Focal peaks enclosed by this isoline. */
  peakIds: string[];
};

export type FocusZones = {
  peaks: FocusPeak[];
  contours: FocusContour[];
};

export type FocusZoneOptions = {
  /** Only consider crowds of this activity (needs grid.layers). */
  activity?: ZoneActivity | null;
  /** Local hour, used to label zones (e.g. "Tramonto" vs "All'aperto"). */
  localHour?: number;
  sunsetHour?: number;
  landmarks?: readonly Landmark[];
  /** Defaults to the city-wide level. */
  detail?: FocusDetail;
};

export function buildFocusZones(grid: CrowdGrid, options: FocusZoneOptions = {}): FocusZones {
  const activity = options.activity ?? null;
  const source = activity
    ? grid.layers?.[activity] ?? new Float32Array(grid.rows * grid.cols)
    : grid.values;
  const detail = options.detail ?? FOCUS_DETAIL.city;
  const values = blurField(grid, dilateField(grid, source, detail.peakSpreadMeters), detail.fieldSmoothingMeters);

  const rawPeaks = findPeaks(values, grid.rows, grid.cols, FOCUS_LEVELS[0].threshold)
    .filter((peak) => peak.score >= MIN_PEAK_SCORE && peak.prominence >= MIN_PEAK_PROMINENCE);

  const usedNames = new Set<string>();
  const primaries: FocusPeak[] = [];
  // rawPeaks is sorted from the highest, so a primary always precedes the
  // secondary spots around it.
  const peaks: FocusPeak[] = rawPeaks.map((peak) => {
    const row = Math.floor(peak.cell / grid.cols);
    const col = peak.cell % grid.cols;
    const latitude = cellLatitude(grid, row);
    const longitude = cellLongitude(grid, col);
    const peakActivity = activity ?? dominantActivity(grid, peak.cell);
    const owner = primaries.find((primary) =>
      distanceMeters(latitude, longitude, primary.latitude, primary.longitude) <= SECONDARY_PEAK_RADIUS_METERS);
    const isPrimary = owner === undefined;
    const name = owner?.name ?? nameForLocation(latitude, longitude, usedNames, options.landmarks ?? MILAN_LANDMARKS);
    const focusPeak: FocusPeak = {
      id: `peak-${row}-${col}`,
      latitude,
      longitude,
      // Report the unblurred density: blurring only shapes the outlines.
      score: Math.round(Math.max(source[peak.cell], peak.score)),
      prominence: Math.round(peak.prominence),
      activity: peakActivity,
      name,
      label: gatheringLabel(peakActivity, options.localHour, options.sunsetHour),
      isPrimary,
    };
    if (isPrimary) primaries.push(focusPeak);
    return focusPeak;
  });

  const peakPoints = rawPeaks.map((peak) => ({
    x: (peak.cell % grid.cols) + 1,
    y: Math.floor(peak.cell / grid.cols) + 1,
  }));

  const cellArea = grid.longitudeStep * metersPerDegreeLongitude(grid.originLatitude)
    * grid.latitudeStep * METERS_PER_DEGREE_LATITUDE;
  const minRingArea = detail.minRingAreaSquareMeters / cellArea;

  const contours: FocusContour[] = [];
  FOCUS_LEVELS.forEach((level, levelIndex) => {
    const rings = traceIsolines(values, grid.rows, grid.cols, level.threshold);
    const outers = rings.filter((ring) => signedArea(ring) > minRingArea);
    const holes = rings.filter((ring) => signedArea(ring) < -minRingArea);

    outers.forEach((ring, ringIndex) => {
      const peakIds = peaks
        .filter((_, index) => pointInRing(peakPoints[index], ring))
        .map((peak) => peak.id);
      if (peakIds.length === 0) return;

      const ringHoles = holes.filter((hole) => pointInRing(hole[0], ring));
      contours.push({
        id: `contour-${levelIndex}-${ringIndex}`,
        levelIndex,
        color: level.color,
        coordinates: toLatLng(grid, smoothRing(grid, ring, detail)),
        holes: ringHoles.map((hole) => toLatLng(grid, smoothRing(grid, hole, detail))),
        peakIds,
      });
    });
  });

  return { peaks, contours };
}

/** Grey-scale dilation: each cell takes the maximum within a disc of `radiusMeters`. */
function dilateField(grid: CrowdGrid, values: Float32Array, radiusMeters: number): Float32Array {
  const cellMetersX = grid.longitudeStep * metersPerDegreeLongitude(grid.originLatitude);
  const cellMetersY = grid.latitudeStep * METERS_PER_DEGREE_LATITUDE;
  const radiusCols = Math.floor(radiusMeters / cellMetersX);
  const radiusRows = Math.floor(radiusMeters / cellMetersY);
  if (radiusCols < 1 && radiusRows < 1) return values;

  const offsets: [number, number][] = [];
  for (let dr = -radiusRows; dr <= radiusRows; dr += 1) {
    for (let dc = -radiusCols; dc <= radiusCols; dc += 1) {
      if ((dr * cellMetersY) ** 2 + (dc * cellMetersX) ** 2 <= radiusMeters ** 2) offsets.push([dr, dc]);
    }
  }

  const { rows, cols } = grid;
  const dilated = new Float32Array(values.length);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let value = 0;
      for (const [dr, dc] of offsets) {
        const r = row + dr;
        const c = col + dc;
        if (r >= 0 && c >= 0 && r < rows && c < cols) value = Math.max(value, values[r * cols + c]);
      }
      dilated[row * cols + col] = value;
    }
  }
  return dilated;
}

/** Separable gaussian blur with a radius in meters. */
function blurField(grid: CrowdGrid, values: Float32Array, sigmaMeters: number): Float32Array {
  const cellMetersX = grid.longitudeStep * metersPerDegreeLongitude(grid.originLatitude);
  const cellMetersY = grid.latitudeStep * METERS_PER_DEGREE_LATITUDE;

  const kernel = (sigmaCells: number) => {
    const radius = Math.max(1, Math.ceil(sigmaCells * 3));
    const weights = Array.from({ length: radius * 2 + 1 }, (_, k) => Math.exp(-0.5 * ((k - radius) / sigmaCells) ** 2));
    const sum = weights.reduce((total, weight) => total + weight, 0);
    return { radius, weights: weights.map((weight) => weight / sum) };
  };
  const horizontal = kernel(sigmaMeters / cellMetersX);
  const vertical = kernel(sigmaMeters / cellMetersY);

  const { rows, cols } = grid;
  const temp = new Float32Array(values.length);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let value = 0;
      for (let k = -horizontal.radius; k <= horizontal.radius; k += 1) {
        const c = col + k;
        if (c >= 0 && c < cols) value += values[row * cols + c] * horizontal.weights[k + horizontal.radius];
      }
      temp[row * cols + col] = value;
    }
  }
  const blurred = new Float32Array(values.length);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let value = 0;
      for (let k = -vertical.radius; k <= vertical.radius; k += 1) {
        const r = row + k;
        if (r >= 0 && r < rows) value += temp[r * cols + col] * vertical.weights[k + vertical.radius];
      }
      blurred[row * cols + col] = value;
    }
  }
  return blurred;
}

/* ---------------------------------------------------------------------------
   Peaks and prominence
--------------------------------------------------------------------------- */

type RawPeak = { cell: number; score: number; prominence: number };

/**
 * Finds local maxima and their topographic prominence with a single
 * union-find sweep from the highest cell down: when two "islands" merge at a
 * saddle, the lower peak's prominence is its height minus the saddle height.
 * Cells below `floor` are ignored, so prominence is measured against it.
 */
export function findPeaks(values: Float32Array, rows: number, cols: number, floor: number): RawPeak[] {
  const order: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] >= floor) order.push(index);
  }
  order.sort((left, right) => values[right] - values[left]);

  const parent = new Int32Array(values.length).fill(-1);
  const peakOfRoot = new Map<number, number>();
  const prominence = new Map<number, number>();

  const find = (cell: number): number => {
    let root = cell;
    while (parent[root] !== root) root = parent[root];
    let node = cell;
    while (parent[node] !== root) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };

  for (const cell of order) {
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    const roots = new Set<number>();
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        const neighbour = r * cols + c;
        if (parent[neighbour] !== -1) roots.add(find(neighbour));
      }
    }

    if (roots.size === 0) {
      parent[cell] = cell;
      peakOfRoot.set(cell, cell);
      continue;
    }

    let winner = -1;
    for (const root of roots) {
      if (winner === -1 || values[peakOfRoot.get(root)!] > values[peakOfRoot.get(winner)!]) winner = root;
    }
    parent[cell] = winner;
    for (const root of roots) {
      if (root === winner) continue;
      const peak = peakOfRoot.get(root)!;
      prominence.set(peak, values[peak] - values[cell]);
      parent[root] = winner;
    }
  }

  const peaks: RawPeak[] = [];
  for (const peak of peakOfRoot.values()) {
    peaks.push({
      cell: peak,
      score: values[peak],
      prominence: prominence.get(peak) ?? values[peak] - floor,
    });
  }
  return peaks.sort((left, right) => right.score - left.score);
}

/* ---------------------------------------------------------------------------
   Isolines (marching squares)
--------------------------------------------------------------------------- */

type Point = { x: number; y: number };

/**
 * Closed isolines at `level`, in padded grid coordinates (x = col + 1,
 * y = row + 1). The grid is padded with zeros so every line closes. Rings are
 * oriented with higher ground on the left: outer boundaries have a positive
 * signed area, holes a negative one.
 */
export function traceIsolines(values: Float32Array, rows: number, cols: number, level: number): Point[][] {
  const width = cols + 2;
  const height = rows + 2;
  const at = (x: number, y: number) =>
    x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1 ? 0 : values[(y - 1) * cols + (x - 1)];

  type Segment = { startKey: number; endKey: number; start: Point };
  const byStart = new Map<number, Segment>();

  const hKey = (x: number, y: number) => (y * width + x) * 2;
  const vKey = (x: number, y: number) => (y * width + x) * 2 + 1;

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const v00 = at(x, y);
      const v10 = at(x + 1, y);
      const v11 = at(x + 1, y + 1);
      const v01 = at(x, y + 1);
      const index = (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v11 >= level ? 4 : 0) | (v01 >= level ? 8 : 0);
      if (index === 0 || index === 15) continue;

      const lerp = (a: number, b: number) => (a === b ? 0.5 : (level - a) / (b - a));
      const edges = {
        B: { key: hKey(x, y), point: { x: x + lerp(v00, v10), y } },
        R: { key: vKey(x + 1, y), point: { x: x + 1, y: y + lerp(v10, v11) } },
        T: { key: hKey(x, y + 1), point: { x: x + lerp(v01, v11), y: y + 1 } },
        L: { key: vKey(x, y), point: { x, y: y + lerp(v00, v01) } },
      };
      type Edge = keyof typeof edges;

      const centerHigh = (v00 + v10 + v11 + v01) / 4 >= level;
      const pairs: [Edge, Edge][] = (() => {
        switch (index) {
          case 1: case 14: return [['L', 'B']];
          case 2: case 13: return [['B', 'R']];
          case 3: case 12: return [['L', 'R']];
          case 4: case 11: return [['R', 'T']];
          case 6: case 9: return [['B', 'T']];
          case 7: case 8: return [['L', 'T']];
          case 5: return centerHigh ? [['B', 'R'], ['T', 'L']] : [['L', 'B'], ['R', 'T']];
          case 10: return centerHigh ? [['L', 'B'], ['R', 'T']] : [['B', 'R'], ['T', 'L']];
          default: return [];
        }
      })();

      const bilinear = (px: number, py: number) => {
        const u = Math.min(1, Math.max(0, px - x));
        const v = Math.min(1, Math.max(0, py - y));
        return v00 * (1 - u) * (1 - v) + v10 * u * (1 - v) + v11 * u * v + v01 * (1 - u) * v;
      };

      for (const [first, second] of pairs) {
        let start = edges[first];
        let end = edges[second];
        // Orient so that higher ground is on the left of start → end.
        const dx = end.point.x - start.point.x;
        const dy = end.point.y - start.point.y;
        const length = Math.hypot(dx, dy) || 1;
        const nx = (-dy / length) * 0.05;
        const ny = (dx / length) * 0.05;
        const mx = (start.point.x + end.point.x) / 2;
        const my = (start.point.y + end.point.y) / 2;
        if (bilinear(mx + nx, my + ny) < bilinear(mx - nx, my - ny)) [start, end] = [end, start];
        byStart.set(start.key, { startKey: start.key, endKey: end.key, start: start.point });
      }
    }
  }

  const rings: Point[][] = [];
  const used = new Set<number>();
  for (const segment of byStart.values()) {
    if (used.has(segment.startKey)) continue;
    const ring: Point[] = [];
    let current: Segment | undefined = segment;
    while (current && !used.has(current.startKey)) {
      used.add(current.startKey);
      ring.push(current.start);
      current = byStart.get(current.endKey);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

export function signedArea(ring: readonly Point[]): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

export function pointInRing(point: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index];
    const b = ring[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Turns a marching-squares ring into a soft outline at real-world scale:
 * resample it every few meters, then apply a circular gaussian along the
 * outline. The smoothing radius is in meters, so the corner radius is the same
 * whatever the grid resolution. Shrinkage is negligible for zones much larger
 * than the radius (≈3% for a 150 m zone).
 */
export function smoothRing(grid: CrowdGrid, ring: readonly Point[], detail: FocusDetail): Point[] {
  const metersX = grid.longitudeStep * metersPerDegreeLongitude(grid.originLatitude);
  const metersY = grid.latitudeStep * METERS_PER_DEGREE_LATITUDE;
  const points = ring.map((point) => ({ x: point.x * metersX, y: point.y * metersY }));

  // Uniform resampling along the perimeter.
  let perimeter = 0;
  const lengths = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const length = Math.hypot(next.x - point.x, next.y - point.y);
    perimeter += length;
    return length;
  });
  const count = Math.max(12, Math.round(perimeter / detail.vertexSpacingMeters));
  const step = perimeter / count;
  const resampled: Point[] = [];
  let segment = 0;
  let travelled = 0;
  for (let index = 0; index < count; index += 1) {
    const target = index * step;
    while (segment < points.length - 1 && travelled + lengths[segment] < target) {
      travelled += lengths[segment];
      segment += 1;
    }
    const a = points[segment];
    const b = points[(segment + 1) % points.length];
    const t = lengths[segment] > 0 ? Math.min(1, (target - travelled) / lengths[segment]) : 0;
    resampled.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }

  // Circular gaussian along the outline; the kernel never exceeds a third of
  // the ring, so tiny rings are rounded without collapsing.
  const sigma = Math.min(detail.outlineSmoothingMeters / step, count / 6);
  const radius = Math.ceil(sigma * 3);
  const weights = Array.from({ length: radius * 2 + 1 }, (_, k) => Math.exp(-0.5 * ((k - radius) / sigma) ** 2));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

  return resampled.map((_, index) => {
    let x = 0;
    let y = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const point = resampled[(index + k + count * 4) % count];
      const weight = weights[k + radius];
      x += point.x * weight;
      y += point.y * weight;
    }
    return { x: x / weightSum / metersX, y: y / weightSum / metersY };
  });
}

function toLatLng(grid: CrowdGrid, ring: readonly Point[]): LatLng[] {
  return ring.map((point) => ({
    latitude: grid.originLatitude + (point.y - 1) * grid.latitudeStep,
    longitude: grid.originLongitude + (point.x - 1) * grid.longitudeStep,
  }));
}

/* ---------------------------------------------------------------------------
   Naming
--------------------------------------------------------------------------- */

function dominantActivity(grid: CrowdGrid, cell: number): ZoneActivity | null {
  if (!grid.layers) return null;
  let best: ZoneActivity | null = null;
  let bestValue = 0;
  for (const activity of ZONE_ACTIVITIES) {
    const value = grid.layers[activity]?.[cell] ?? 0;
    if (value > bestValue) {
      best = activity;
      bestValue = value;
    }
  }
  return best;
}

/** Nearest unused landmark; falls back to a numbered name when all are taken. */
function nameForLocation(
  latitude: number,
  longitude: number,
  usedNames: Set<string>,
  landmarks: readonly Landmark[],
): string {
  const nearby = landmarks
    .map((landmark) => ({
      landmark,
      distance: distanceMeters(latitude, longitude, landmark.latitude, landmark.longitude),
    }))
    .filter((entry) => entry.distance <= LANDMARK_RADIUS_METERS)
    .sort((left, right) => left.distance - right.distance);

  const free = nearby.find((entry) => !usedNames.has(entry.landmark.name));
  const base = free?.landmark.name ?? nearby[0]?.landmark.name ?? 'Zona';
  let name = base;
  for (let suffix = 2; usedNames.has(name); suffix += 1) name = `${base} ${suffix}`;
  usedNames.add(name);
  return name;
}

export function gatheringLabel(
  activity: ZoneActivity | null,
  localHour?: number,
  sunsetHour?: number,
): string {
  switch (activity) {
    case 'aperitivo':
      return 'Aperitivo';
    case 'food':
      return localHour !== undefined && localHour >= 11 && localHour < 16 ? 'Pranzo' : 'Cena';
    case 'nightlife':
      return 'Nightlife';
    case 'outdoor':
      return localHour !== undefined && sunsetHour !== undefined && Math.abs(localHour - sunsetHour) <= 1.2
        ? 'Tramonto'
        : "All'aperto";
    case 'culture':
      return 'Passeggio';
    default:
      return 'Folla';
  }
}
