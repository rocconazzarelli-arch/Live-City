/**
 * Regular latitude/longitude grid of street-level crowd density.
 *
 * Every cell holds a 0–100 density score for people outdoors (streets, squares,
 * parks, venues). Residential presence is never part of the field. Optional
 * per-activity layers split the same density by type of concentration, so the
 * map can isolate e.g. only aperitivo crowds.
 */

export type ZoneActivity =
  | 'aperitivo'
  | 'food'
  | 'nightlife'
  | 'outdoor'
  | 'culture';

export const ZONE_ACTIVITIES: readonly ZoneActivity[] = [
  'aperitivo',
  'food',
  'nightlife',
  'outdoor',
  'culture',
];

export type CrowdGrid = {
  /** Latitude of row 0. Rows grow northwards. */
  originLatitude: number;
  /** Longitude of column 0. Columns grow eastwards. */
  originLongitude: number;
  latitudeStep: number;
  longitudeStep: number;
  rows: number;
  cols: number;
  /** Row-major density scores, 0–100. */
  values: Float32Array;
  /** Row-major density scores per activity, 0–100, when the source knows them. */
  layers?: Partial<Record<ZoneActivity, Float32Array>>;
};

export type GridBounds = {
  south: number;
  north: number;
  west: number;
  east: number;
};

export function createEmptyGrid(bounds: GridBounds, cellSizeMeters: number): CrowdGrid {
  const latitudeStep = cellSizeMeters / METERS_PER_DEGREE_LATITUDE;
  const midLatitude = (bounds.south + bounds.north) / 2;
  const longitudeStep = cellSizeMeters / metersPerDegreeLongitude(midLatitude);
  const rows = Math.max(2, Math.ceil((bounds.north - bounds.south) / latitudeStep) + 1);
  const cols = Math.max(2, Math.ceil((bounds.east - bounds.west) / longitudeStep) + 1);

  return {
    originLatitude: bounds.south,
    originLongitude: bounds.west,
    latitudeStep,
    longitudeStep,
    rows,
    cols,
    values: new Float32Array(rows * cols),
  };
}

export function cellLatitude(grid: CrowdGrid, row: number): number {
  return grid.originLatitude + row * grid.latitudeStep;
}

export function cellLongitude(grid: CrowdGrid, col: number): number {
  return grid.originLongitude + col * grid.longitudeStep;
}

export const METERS_PER_DEGREE_LATITUDE = 111_320;

export function metersPerDegreeLongitude(latitude: number): number {
  return METERS_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180);
}

/** Planar distance in meters, accurate enough at city scale. */
export function distanceMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const dy = (latitudeA - latitudeB) * METERS_PER_DEGREE_LATITUDE;
  const dx = (longitudeA - longitudeB) * metersPerDegreeLongitude((latitudeA + latitudeB) / 2);
  return Math.hypot(dx, dy);
}

/**
 * Splats sparse aggregated cells (e.g. the privacy-safe backend heatmap) onto a
 * grid as soft gaussians, so they can go through the same focus-zone pipeline
 * as a dense field. Overlapping cells keep the strongest value, not the sum,
 * because each input score is already a density.
 */
export function gridFromScoredPoints(
  points: readonly { latitude: number; longitude: number; score: number; radius: number }[],
  cellSizeMeters = 90,
): CrowdGrid | null {
  if (points.length === 0) return null;

  const margin = Math.max(...points.map((point) => point.radius)) * 2.5;
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const midLatitude = latitudes.reduce((sum, value) => sum + value, 0) / latitudes.length;
  const latitudeMargin = margin / METERS_PER_DEGREE_LATITUDE;
  const longitudeMargin = margin / metersPerDegreeLongitude(midLatitude);
  const grid = createEmptyGrid(
    {
      south: Math.min(...latitudes) - latitudeMargin,
      north: Math.max(...latitudes) + latitudeMargin,
      west: Math.min(...longitudes) - longitudeMargin,
      east: Math.max(...longitudes) + longitudeMargin,
    },
    cellSizeMeters,
  );

  for (let row = 0; row < grid.rows; row += 1) {
    const latitude = cellLatitude(grid, row);
    for (let col = 0; col < grid.cols; col += 1) {
      const longitude = cellLongitude(grid, col);
      let value = 0;
      for (const point of points) {
        const sigma = Math.max(point.radius, 1) / 1.6;
        const distance = distanceMeters(latitude, longitude, point.latitude, point.longitude);
        if (distance > sigma * 4) continue;
        const score = Math.min(Math.max(point.score, 0), 100);
        value = Math.max(value, score * Math.exp(-0.5 * (distance / sigma) ** 2));
      }
      grid.values[row * grid.cols + col] = value;
    }
  }

  return grid;
}
