import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-refresh-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GRID_SIZE = 0.004;
const SOURCE_URLS = {
  metroStops: "https://dati.comune.milano.it/dataset/b7344a8f-0ef5-424b-a902-f7f06e32dd67/resource/dd6a770a-b321-44f0-b58c-9725d84409bb/download/tpl_metrofermate.geojson",
  surfaceStops: "https://dati.comune.milano.it/dataset/ac494f5d-acd3-4fd3-8cfc-ed24f5c3d923/resource/7d21bd77-3ad1-4235-9a40-8a8cdfeb65a0/download/tpl_fermate.geojson",
  metroSchedule: "https://dati.comune.milano.it/dataset/581f1e5c-cb68-4e12-8d43-4f24828f9a4f/resource/2f8141e5-122e-4b3c-a4b1-562d881f3f6f/download/tpl_metroorari.csv",
  surfaceSchedule: "https://dati.comune.milano.it/dataset/32112fb0-4c62-4ec0-aef4-e70b05f0fe41/resource/67bbf039-a22b-4ee3-b32e-31735bf1354d/download/tpl_orari.csv",
} as const;

type DayType = "L" | "S" | "F";
type Mode = "metro" | "surface";
type CsvRow = Record<string, string>;
type StopFeature = {
  properties?: { linee?: string | number | null };
  geometry?: { type?: string; coordinates?: [number, number] };
};
type GeoJson = { features?: StopFeature[] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function parseDelimitedLine(line: string): string[] {
  const cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ";" && !quoted) {
      cells.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  cells.push(value.trim());
  return cells;
}

function parseCsv(text: string): CsvRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseDelimitedLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseDelimitedLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function numeric(value: string | undefined): number {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

function activeHours(start: string, end: string): number[] {
  const startMinute = minuteOfDay(start);
  let endMinute = minuteOfDay(end);
  if (endMinute <= startMinute) endMinute += 24 * 60;
  const hours = new Set<number>();
  for (let minute = startMinute; minute <= endMinute; minute += 60) {
    hours.add(Math.floor(minute / 60) % 24);
  }
  return [...hours];
}

function scheduledRateForHour(row: CsvRow, hour: number, hours: number[]): number {
  const daily = numeric(row.corse_gior);
  const peak = numeric(row.corse_punt);
  const soft = numeric(row.corse_morb);
  const evening = numeric(row.corse_sera);
  if (!hours.includes(hour) || daily <= 0) return 0;
  if ((hour === 7 || hour === 8) && peak > 0) return peak / 2;
  if ((hour === 10 || hour === 11) && soft > 0) return soft / 2;
  if ((hour === 22 || hour === 23) && evening > 0) return evening / 2;

  const specialHours = new Set([7, 8, 10, 11, 22, 23]);
  const regularHourCount = Math.max(1, hours.filter((item) => !specialHours.has(item)).length);
  return Math.max(0, daily - peak - soft - evening) / regularHourCount;
}

function gridFor(latitude: number, longitude: number) {
  const latitudeCell = Math.floor(latitude / GRID_SIZE);
  const longitudeCell = Math.floor(longitude / GRID_SIZE);
  return {
    gridKey: `${latitudeCell}:${longitudeCell}`,
    latitude: (latitudeCell + 0.5) * GRID_SIZE,
    longitude: (longitudeCell + 0.5) * GRID_SIZE,
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 1;
}

async function fetchSource(url: string): Promise<{ text: string; updatedAt: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`Mobility source HTTP ${response.status}: ${url}`);
  return {
    text: await response.text(),
    updatedAt: response.headers.get("last-modified") ?? new Date().toISOString(),
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const startedAt = Date.now();
  try {
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const configuredSecret = requiredEnv("CROWD_PIPELINE_SECRET");
    const serviceRoleAuthorized =
      request.headers.get("Authorization") === `Bearer ${serviceRoleKey}` ||
      request.headers.get("apikey") === serviceRoleKey;
    const refreshSecretAuthorized = request.headers.get("x-refresh-secret") === configuredSecret;
    if (!serviceRoleAuthorized && !refreshSecretAuthorized) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    const [metroStopsSource, surfaceStopsSource, metroScheduleSource, surfaceScheduleSource] =
      await Promise.all([
        fetchSource(SOURCE_URLS.metroStops),
        fetchSource(SOURCE_URLS.surfaceStops),
        fetchSource(SOURCE_URLS.metroSchedule),
        fetchSource(SOURCE_URLS.surfaceSchedule),
      ]);

    const scheduleRates = new Map<string, number>();
    const registerSchedule = (text: string, mode: Mode) => {
      for (const row of parseCsv(text)) {
        const dayType = row.tipo_giorno as DayType;
        const line = row.linea;
        if (!line || !["L", "S", "F"].includes(dayType)) continue;
        const hours = activeHours(row.inizio, row.fine);
        for (let hour = 0; hour < 24; hour += 1) {
          const rate = scheduledRateForHour(row, hour, hours);
          if (rate <= 0) continue;
          const key = `${mode}:${line}:${dayType}:${hour}`;
          scheduleRates.set(key, (scheduleRates.get(key) ?? 0) + rate);
        }
      }
    };
    registerSchedule(metroScheduleSource.text, "metro");
    registerSchedule(surfaceScheduleSource.text, "surface");

    const cells = new Map<string, {
      latitude: number;
      longitude: number;
      stopIds: Set<string>;
      lines: Set<string>;
    }>();
    const registerStops = (text: string, mode: Mode) => {
      const geoJson = JSON.parse(text) as GeoJson;
      for (const [index, feature] of (geoJson.features ?? []).entries()) {
        const coordinates = feature.geometry?.coordinates;
        if (feature.geometry?.type !== "Point" || !coordinates) continue;
        const [longitude, latitude] = coordinates.map(Number);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
        const grid = gridFor(latitude, longitude);
        const cell = cells.get(grid.gridKey) ?? {
          latitude: grid.latitude,
          longitude: grid.longitude,
          stopIds: new Set<string>(),
          lines: new Set<string>(),
        };
        cell.stopIds.add(`${mode}:${index}`);
        String(feature.properties?.linee ?? "")
          .split(",")
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => cell.lines.add(`${mode}:${line}`));
        cells.set(grid.gridKey, cell);
      }
    };
    registerStops(metroStopsSource.text, "metro");
    registerStops(surfaceStopsSource.text, "surface");

    const sourceUpdatedAt = [
      metroStopsSource.updatedAt,
      surfaceStopsSource.updatedAt,
      metroScheduleSource.updatedAt,
      surfaceScheduleSource.updatedAt,
    ].sort().at(-1) ?? new Date().toISOString();
    const refreshedAt = new Date().toISOString();
    const provisionalRows: Array<{
      grid_key: string;
      center_latitude: number;
      center_longitude: number;
      local_day_type: DayType;
      local_hour: number;
      service_intensity: number;
      mobility_score: number;
      stop_count: number;
      source_name: string;
      source_updated_at: string;
      refreshed_at: string;
      metadata: Record<string, unknown>;
    }> = [];

    for (const [gridKey, cell] of cells.entries()) {
      for (const dayType of ["L", "S", "F"] as DayType[]) {
        for (let hour = 0; hour < 24; hour += 1) {
          let intensity = 0;
          for (const modeAndLine of cell.lines) {
            intensity += scheduleRates.get(`${modeAndLine}:${dayType}:${hour}`) ?? 0;
          }
          if (intensity <= 0) continue;
          provisionalRows.push({
            grid_key: gridKey,
            center_latitude: cell.latitude,
            center_longitude: cell.longitude,
            local_day_type: dayType,
            local_hour: hour,
            service_intensity: Math.round(intensity * 100) / 100,
            mobility_score: 0,
            stop_count: cell.stopIds.size,
            source_name: "comune_milano_amat_schedule",
            source_updated_at: new Date(sourceUpdatedAt).toISOString(),
            refreshed_at: refreshedAt,
            metadata: {
              lineCount: cell.lines.size,
              sourceMode: "scheduled_proxy",
              license: "CC BY 4.0",
              disclaimer: "Public transport supply index, not passenger count or live foot traffic",
            },
          });
        }
      }
    }

    const p90BySlot = new Map<string, number>();
    for (const dayType of ["L", "S", "F"] as DayType[]) {
      for (let hour = 0; hour < 24; hour += 1) {
        const slot = `${dayType}:${hour}`;
        p90BySlot.set(
          slot,
          percentile(
            provisionalRows
              .filter((row) => row.local_day_type === dayType && row.local_hour === hour)
              .map((row) => row.service_intensity),
            0.9,
          ),
        );
      }
    }
    for (const row of provisionalRows) {
      const p90 = p90BySlot.get(`${row.local_day_type}:${row.local_hour}`) ?? 1;
      row.mobility_score = Math.round(clamp(12 + 88 * Math.sqrt(Math.min(1, row.service_intensity / p90))));
      row.metadata = { ...row.metadata, normalisation: "slot_p90_sqrt", slotP90: Math.round(p90 * 100) / 100 };
    }

    const supabase = createClient(requiredEnv("SUPABASE_URL"), serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const batchSize = 800;
    for (let index = 0; index < provisionalRows.length; index += batchSize) {
      const { error } = await supabase
        .from("mobility_cell_profiles")
        .upsert(provisionalRows.slice(index, index + batchSize), {
          onConflict: "grid_key,local_day_type,local_hour",
        });
      if (error) throw new Error(`Mobility profile upsert failed: ${error.message}`);
    }

    const { error: cleanupError } = await supabase
      .from("mobility_cell_profiles")
      .delete()
      .lt("refreshed_at", refreshedAt);
    if (cleanupError) throw new Error(`Mobility profile cleanup failed: ${cleanupError.message}`);

    const stats = {
      source: "Comune di Milano / AMAT scheduled public transport",
      sourceMode: "scheduled_proxy",
      cells: cells.size,
      scheduleRates: scheduleRates.size,
      profilesWritten: provisionalRows.length,
      sourceUpdatedAt: new Date(sourceUpdatedAt).toISOString(),
      durationMs: Date.now() - startedAt,
    };
    console.log("MOBILITY SOURCE REFRESH COMPLETATO", stats);
    return json({ ok: true, stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown mobility refresh error";
    console.error("MOBILITY SOURCE REFRESH ERROR", { message });
    return json({ ok: false, error: message, durationMs: Date.now() - startedAt }, 500);
  }
});
