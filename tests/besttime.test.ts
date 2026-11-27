import {
  classifyBestTimeLivePayload,
  normalizeBestTimeLiveScore,
} from "../supabase/functions/_shared/besttime.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("BestTime live score keeps valid values and saturates exceptional peaks", () => {
  assertEquals(normalizeBestTimeLiveScore(0), 0, "zero");
  assertEquals(normalizeBestTimeLiveScore(74.6), 75, "rounding");
  assertEquals(normalizeBestTimeLiveScore(100), 100, "weekly peak");
  assertEquals(normalizeBestTimeLiveScore(200), 100, "above-peak live traffic");
});

Deno.test("BestTime live score rejects missing, closed, and malformed values", () => {
  assertEquals(normalizeBestTimeLiveScore(999), null, "closed sentinel");
  assertEquals(normalizeBestTimeLiveScore(-1), null, "negative");
  assertEquals(normalizeBestTimeLiveScore("80"), null, "string");
  assertEquals(normalizeBestTimeLiveScore(Number.NaN), null, "NaN");
});

Deno.test("BestTime payload classification suspends only explicit per-venue unavailability", () => {
  assertEquals(
    classifyBestTimeLivePayload({
      status: "OK",
      analysis: {
        venue_live_busyness_available: true,
        venue_live_busyness: 64,
      },
    }).kind,
    "live",
    "usable live payload",
  );
  assertEquals(
    classifyBestTimeLivePayload({
      status: "OK",
      analysis: {
        venue_live_busyness_available: false,
        venue_live_busyness: 999,
      },
    }).kind,
    "unavailable",
    "explicit venue unavailability",
  );
  assertEquals(
    classifyBestTimeLivePayload({
      status: "Error",
      message: "No live data available for this venue at this moment",
    }).kind,
    "unavailable",
    "provider no-live error",
  );
  assertEquals(
    classifyBestTimeLivePayload({ status: "Error" }).kind,
    "failed",
    "quota/key/provider error",
  );
  assertEquals(
    classifyBestTimeLivePayload(null).kind,
    "failed",
    "malformed payload",
  );
});
