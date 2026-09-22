import { createClient } from "npm:@supabase/supabase-js@2";

type PlaceCategory = "aperitivo" | "food" | "nightlife" | "outdoor" | "culture";
type OverpassElement = {
  id: number;
  type: "node" | "way" | "relation";
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

const TARGET_PER_CATEGORY = 60;
const TARGET_TOTAL = 300;
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-refresh-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function categoryFor(tags: Record<string, string>): PlaceCategory | null {
  const amenity = tags.amenity;
  if (["nightclub", "music_venue"].includes(amenity) || tags.club === "nightclub" || tags.leisure === "dance") {
    return "nightlife";
  }
  if (["bar", "pub", "biergarten"].includes(amenity)) return "aperitivo";
  if (["restaurant", "cafe", "fast_food", "food_court", "ice_cream"].includes(amenity)) return "food";
  if (["park", "garden", "nature_reserve"].includes(tags.leisure)) return "outdoor";
  if (["museum", "gallery", "attraction"].includes(tags.tourism) ||
    ["theatre", "cinema", "arts_centre"].includes(amenity)) return "culture";
  return null;
}

function normalizedName(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function quality(tags: Record<string, string>): number {
  return Number(Boolean(tags.website || tags["contact:website"])) * 3 +
    Number(Boolean(tags.opening_hours)) * 2 +
    Number(Boolean(tags["addr:street"])) * 2 +
    Number(Boolean(tags.phone || tags["contact:phone"])) +
    Number(Boolean(tags.wikidata || tags.wikipedia));
}

function addressFor(tags: Record<string, string>): string | null {
  const street = tags["addr:street"];
  const number = tags["addr:housenumber"];
  if (!street) return tags["addr:full"] ?? null;
  return [street, number, "Milano"].filter(Boolean).join(" ");
}

async function fetchOverpass(query: string): Promise<OverpassElement[]> {
  const failures: string[] = [];
  for (const endpoint of OVERPASS_URLS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "LIVE-CITY/1.0",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(40_000),
      });
      if (!response.ok) {
        failures.push(`${endpoint}: ${response.status}`);
        continue;
      }
      const payload = await response.json() as { elements?: OverpassElement[] };
      return payload.elements ?? [];
    } catch (error) {
      failures.push(`${endpoint}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  throw new Error(`OpenStreetMap discovery failed (${failures.join(", ")})`);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const secret = Deno.env.get("CROWD_PIPELINE_SECRET");
    const authorized = request.headers.get("Authorization") === `Bearer ${serviceRoleKey}` ||
      request.headers.get("apikey") === serviceRoleKey ||
      Boolean(secret && request.headers.get("x-refresh-secret") === secret);
    if (!authorized) return json({ ok: false, error: "Unauthorized" }, 401);
    if (!serviceRoleKey || !supabaseUrl) throw new Error("Supabase backend configuration is incomplete");

    const commercialQuery = `[out:json][timeout:30];
      nwr[amenity~"^(nightclub|music_venue|bar|pub|biergarten|restaurant|cafe|fast_food|food_court|ice_cream)$"][name](45.41,9.08,45.54,9.30);
      out center tags 600;`;
    const leisureQuery = `[out:json][timeout:30];(
      nwr[leisure~"^(park|garden|nature_reserve|dance)$"][name](45.41,9.08,45.54,9.30);
      nwr[tourism~"^(museum|gallery|attraction)$"][name](45.41,9.08,45.54,9.30);
      nwr[amenity~"^(theatre|cinema|arts_centre)$"][name](45.41,9.08,45.54,9.30);
      nwr[club="nightclub"][name](45.41,9.08,45.54,9.30);
    );out center tags 500;`;
    const [commercialElements, leisureElements] = await Promise.all([
      fetchOverpass(commercialQuery),
      fetchOverpass(leisureQuery),
    ]);
    const elements = [...commercialElements, ...leisureElements];

    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: existingRows, error: existingError } = await supabase
      .from("places")
      .select("id, fsq_place_id, name, category")
      .eq("is_active", true);
    if (existingError) throw new Error(existingError.message);
    const existingNames = new Set((existingRows ?? []).map((row) => normalizedName(row.name)));
    const existingIds = new Set((existingRows ?? []).map((row) => row.fsq_place_id));
    const counts = new Map<PlaceCategory, number>();
    for (const category of ["aperitivo", "food", "nightlife", "outdoor", "culture"] as const) {
      counts.set(category, (existingRows ?? []).filter((row) => row.category === category).length);
    }

    const candidates = elements.flatMap((element) => {
      const tags = element.tags ?? {};
      const category = categoryFor(tags);
      const latitude = element.lat ?? element.center?.lat;
      const longitude = element.lon ?? element.center?.lon;
      const name = tags.name?.trim();
      if (!category || !name || latitude === undefined || longitude === undefined) return [];
      return [{
        fsq_place_id: `osm:${element.type}:${element.id}`,
        name,
        address: addressFor(tags),
        category,
        latitude,
        longitude,
        is_active: true,
        catalog_source: "openstreetmap",
        source_place_id: `${element.type}:${element.id}`,
        quality: quality(tags),
      }];
    }).sort((left, right) => right.quality - left.quality || left.name.localeCompare(right.name));

    const selected: Omit<(typeof candidates)[number], "quality">[] = [];
    const seenNames = new Set(existingNames);
    for (const candidate of candidates) {
      if ((counts.get(candidate.category) ?? 0) >= TARGET_PER_CATEGORY) continue;
      const normalized = normalizedName(candidate.name);
      if (existingIds.has(candidate.fsq_place_id) || seenNames.has(normalized)) continue;
      const { quality: _quality, ...row } = candidate;
      selected.push(row);
      seenNames.add(normalized);
      counts.set(candidate.category, (counts.get(candidate.category) ?? 0) + 1);
    }

    for (const candidate of candidates) {
      if ((existingRows?.length ?? 0) + selected.length >= TARGET_TOTAL) break;
      const normalized = normalizedName(candidate.name);
      if (existingIds.has(candidate.fsq_place_id) || seenNames.has(normalized)) continue;
      const { quality: _quality, ...row } = candidate;
      selected.push(row);
      seenNames.add(normalized);
      counts.set(candidate.category, (counts.get(candidate.category) ?? 0) + 1);
    }

    if (selected.length > 0) {
      const { error } = await supabase.from("places").upsert(selected, { onConflict: "fsq_place_id" });
      if (error) throw new Error(error.message);
    }
    return json({
      ok: true,
      provider: "openstreetmap",
      discovered: elements.length,
      inserted: selected.length,
      activeTotal: (existingRows?.length ?? 0) + selected.length,
      categoryCounts: Object.fromEntries(counts),
      attribution: "© OpenStreetMap contributors",
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Unknown discovery error" }, 500);
  }
});
