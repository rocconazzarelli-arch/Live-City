import {
  cellLatitude,
  cellLongitude,
  createEmptyGrid,
  gridFromScoredPoints,
  type CrowdGrid,
} from "../src/features/map/focus-zones/crowd-grid.ts";
import { generateDemoCrowdField } from "../src/features/map/focus-zones/demo-crowd-field.ts";
import {
  buildFocusZones,
  FOCUS_DETAIL,
  FOCUS_LEVELS,
  pointInRing,
  signedArea,
  traceIsolines,
} from "../src/features/map/focus-zones/focus-zones.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const BOUNDS = { south: 45.44, north: 45.47, west: 9.16, east: 9.2 };

/** Grid with gaussian bumps given as [row, col, height, sigmaCells]. */
function gridWithBumps(bumps: [number, number, number, number][]): CrowdGrid {
  const grid = createEmptyGrid(BOUNDS, 80);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      let value = 0;
      for (const [r, c, height, sigma] of bumps) {
        value += height * Math.exp(-0.5 * (((row - r) / sigma) ** 2 + ((col - c) / sigma) ** 2));
      }
      grid.values[row * grid.cols + col] = Math.min(value, 100);
    }
  }
  return grid;
}

Deno.test("a single crowd bump yields one focal peak with nested isolines", () => {
  const grid = gridWithBumps([[20, 20, 95, 4]]);
  const zones = buildFocusZones(grid);

  assert(zones.peaks.length === 1, `expected 1 peak, got ${zones.peaks.length}`);
  assert(zones.peaks[0].score >= 94, "peak keeps its height");
  const levels = zones.contours.map((contour) => contour.levelIndex).sort();
  assert(levels.join(",") === "0,1,2", `one isoline per level below the peak, got ${levels}`);
  assert(zones.contours.every((contour) => contour.holes.length === 0), "a bump has no holes");
});

Deno.test("isolines are closed, oriented outwards and contain the peak", () => {
  const grid = gridWithBumps([[15, 25, 80, 3]]);
  const rings = traceIsolines(grid.values, grid.rows, grid.cols, 50);
  assert(rings.length === 1, `expected one ring, got ${rings.length}`);
  assert(signedArea(rings[0]) > 0, "outer ring has positive area (high ground on the left)");
  assert(pointInRing({ x: 26, y: 16 }, rings[0]), "ring encloses the peak cell (padded coords)");
});

Deno.test("separate gatherings become separate named focal points", () => {
  const grid = gridWithBumps([[10, 10, 85, 3], [30, 35, 75, 3]]);
  const zones = buildFocusZones(grid);
  assert(zones.peaks.length === 2, `expected 2 peaks, got ${zones.peaks.length}`);
  assert(new Set(zones.peaks.map((peak) => peak.name)).size === 2, "names are unique");
});

Deno.test("outlines are dense and round at street scale", () => {
  const grid = gridWithBumps([[20, 20, 95, 4]]);
  const outline = buildFocusZones(grid).contours.find((contour) => contour.levelIndex === 0)!;
  const points = outline.coordinates;
  assert(points.length > 100, `many vertices for a smooth edge, got ${points.length}`);

  // Turning angle between consecutive 8 m segments stays small: no visible corners.
  const toMeters = (p: { latitude: number; longitude: number }) => ({
    x: p.longitude * 111_320 * Math.cos((45.455 * Math.PI) / 180),
    y: p.latitude * 111_320,
  });
  let sharpest = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = toMeters(points[index]);
    const b = toMeters(points[(index + 1) % points.length]);
    const c = toMeters(points[(index + 2) % points.length]);
    const turn = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
    sharpest = Math.max(sharpest, Math.min(turn, 2 * Math.PI - turn));
  }
  assert(sharpest < (20 * Math.PI) / 180, `max turn per vertex ${((sharpest * 180) / Math.PI).toFixed(1)}°`);
});

Deno.test("a shoulder on a bigger crowd is not a separate focal point", () => {
  // The small bump sits on the flank of the big one: tiny prominence.
  const grid = gridWithBumps([[20, 20, 90, 5], [20, 27, 12, 1.5]]);
  const zones = buildFocusZones(grid);
  assert(zones.peaks.length === 1, `shoulder should merge, got ${zones.peaks.length} peaks`);
});

Deno.test("weak bumps below the focal threshold are not drawn at all", () => {
  const grid = gridWithBumps([[20, 20, 90, 4], [8, 40, 48, 3]]);
  const zones = buildFocusZones(grid);
  assert(zones.peaks.length === 1, "only the strong crowd is focal");
  assert(
    zones.contours.every((contour) => contour.peakIds.includes(zones.peaks[0].id)),
    "no isoline is drawn around the weak bump",
  );
});

Deno.test("a ring-shaped crowd keeps its empty centre as a hole", () => {
  const grid = createEmptyGrid(BOUNDS, 80);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const radius = Math.hypot(row - 20, col - 20);
      // Slight angular variation gives the ring a single highest point.
      const height = 80 + 6 * Math.cos(Math.atan2(row - 20, col - 20));
      grid.values[row * grid.cols + col] = height * Math.exp(-0.5 * ((radius - 8) / 1.8) ** 2);
    }
  }
  const zones = buildFocusZones(grid);
  const outline = zones.contours.find((contour) => contour.levelIndex === 0);
  assert(outline !== undefined, "outer isoline exists");
  assert(outline.holes.length === 1, `expected one hole, got ${outline.holes.length}`);
});

Deno.test("sparse backend cells can feed the same pipeline", () => {
  const grid = gridFromScoredPoints([
    { latitude: 45.4527, longitude: 9.1791, score: 92, radius: 300 },
    { latitude: 45.4822, longitude: 9.1878, score: 80, radius: 250 },
  ]);
  assert(grid !== null, "grid is built");
  const zones = buildFocusZones(grid);
  assert(zones.peaks.length === 2, `expected 2 peaks, got ${zones.peaks.length}`);
  assert(zones.peaks.every((peak) => peak.activity === null && peak.label === "Folla"), "no activity without layers");
  const names = zones.peaks.map((peak) => peak.name).sort().join(",");
  assert(names === "Corso Como,Darsena", `named after landmarks, got ${names}`);
});

/* Demo field ------------------------------------------------------------- */

// Friday 2026-10-30 19:30 Europe/Rome (UTC+1).
const FRIDAY_EVENING = new Date("2026-10-30T18:30:00Z");
// Saturday 2026-10-31 01:00 Europe/Rome.
const SATURDAY_NIGHT = new Date("2026-10-31T00:00:00Z");

Deno.test("demo field: aperitivo hour shows aperitivo zones on the Navigli", () => {
  const field = generateDemoCrowdField(FRIDAY_EVENING);
  assert(Math.abs(field.localHour - 19.5) < 0.01, `local hour is 19:30, got ${field.localHour}`);

  const zones = buildFocusZones(field.grid, { localHour: field.localHour, sunsetHour: field.sunsetHour });
  const aperitivo = zones.peaks.filter((peak) => peak.activity === "aperitivo");
  assert(aperitivo.length >= 3, `expected several aperitivo zones, got ${aperitivo.length}`);
  assert(
    zones.peaks.some((peak) => peak.name === "Darsena" && peak.label === "Aperitivo"),
    `Darsena is an aperitivo zone: ${zones.peaks.map((p) => `${p.label} · ${p.name}`).join(" | ")}`,
  );
});

Deno.test("demo field: activity filter isolates one kind of concentration", () => {
  const field = generateDemoCrowdField(FRIDAY_EVENING);
  const zones = buildFocusZones(field.grid, { activity: "aperitivo", localHour: field.localHour });
  assert(zones.peaks.length > 0, "aperitivo zones exist");
  assert(zones.peaks.every((peak) => peak.activity === "aperitivo"), "only aperitivo zones");

  const night = generateDemoCrowdField(SATURDAY_NIGHT);
  const culture = buildFocusZones(night.grid, { activity: "culture", localHour: night.localHour });
  assert(culture.peaks.length === 0, "no sightseeing crowds at 1 am");
  const nightlife = buildFocusZones(night.grid, { activity: "nightlife", localHour: night.localHour });
  assert(nightlife.peaks.length > 0, "nightlife peaks around 1 am on a Saturday");
});

Deno.test("demo field: pedestrian flows never become focal points on their own", () => {
  // Sunday 2026-11-01 15:00 Europe/Rome, peak walking time.
  for (const iso of ["2026-11-01T14:00:00Z", "2026-10-30T12:00:00Z"]) {
    const field = generateDemoCrowdField(new Date(iso));
    const zones = buildFocusZones(field.grid, { localHour: field.localHour });
    const flows = zones.peaks.filter((peak) => peak.activity === null);
    assert(flows.length === 0, `no activity-less zones, got ${flows.map((p) => p.name).join(", ")}`);
  }
});

Deno.test("zooming in reveals packed spots instead of one big red area", () => {
  // Parco Sempione / Arco della Pace near sunset on a Sunday.
  const now = new Date("2026-11-01T15:00:00Z");
  const bounds = { south: 45.469, north: 45.481, west: 9.163, east: 9.183 };
  const redArea = (level: "city" | "street") => {
    const detail = FOCUS_DETAIL[level];
    const field = generateDemoCrowdField(now, { hourOverride: 16.8, bounds, cellSizeMeters: detail.cellSizeMeters });
    const zones = buildFocusZones(field.grid, { detail, localHour: field.localHour, sunsetHour: field.sunsetHour });
    const red = zones.contours.filter((contour) => contour.levelIndex === FOCUS_LEVELS.length - 1);
    return { zones, area: red.reduce((sum, contour) => sum + polygonAreaSquareMeters(contour.coordinates), 0) };
  };
  const city = redArea("city");
  const street = redArea("street");
  assert(street.area > 0, "packed spots are still red when zoomed in");
  assert(street.area < city.area * 0.6, `red shrinks when zoomed in: ${Math.round(street.area)} vs ${Math.round(city.area)} m²`);
  assert(street.zones.peaks.length > city.zones.peaks.length, "more distinct spots at street level");
  assert(street.zones.peaks.some((peak) => !peak.isPrimary), "spots of an already-named place are secondary (no duplicate tags)");
});

function polygonAreaSquareMeters(points: { latitude: number; longitude: number }[]): number {
  const metersX = 111_320 * Math.cos((45.475 * Math.PI) / 180);
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a.longitude * metersX * b.latitude * 111_320 - b.longitude * metersX * a.latitude * 111_320;
  }
  return Math.abs(area / 2);
}

Deno.test("demo field: residential areas without sources stay empty", () => {
  const field = generateDemoCrowdField(FRIDAY_EVENING);
  const { grid } = field;
  // South-west corner of the bounds, a residential area far from every source.
  assert(grid.values[0] === 0, `corner should be empty, got ${grid.values[0]}`);
  assert(cellLatitude(grid, 0) < 45.44 && cellLongitude(grid, 0) < 9.15, "corner is outside the centre");
  assert(Math.max(...grid.values) <= 100, "scores stay within 0–100");
});

Deno.test("demo field: same instant gives the same field", () => {
  const a = generateDemoCrowdField(FRIDAY_EVENING).grid.values;
  const b = generateDemoCrowdField(FRIDAY_EVENING).grid.values;
  assert(a.every((value, index) => value === b[index]), "deterministic");
});

Deno.test("demo field: Milan sunset is computed in local time", () => {
  const field = generateDemoCrowdField(FRIDAY_EVENING);
  // Real sunset in Milan on 30 Oct 2026 is about 17:05 CET.
  assert(field.sunsetHour > 16.6 && field.sunsetHour < 17.4, `sunset ~17:00, got ${field.sunsetHour}`);
  assert(FOCUS_LEVELS.length === 3, "three isoline levels");
});
