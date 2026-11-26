import {
  isLiveReadDue,
  normalizeLiveReadHours,
  romeHour,
} from "../supabase/functions/_shared/live-schedule.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

Deno.test("romeHour follows CET in winter and CEST in summer", () => {
  assertEquals(romeHour(new Date("2026-11-20T18:30:00Z")), 19, "Nov 18:30Z is 19:30 CET");
  assertEquals(romeHour(new Date("2026-11-20T23:30:00Z")), 0, "Nov 23:30Z is 00:30 CET");
  assertEquals(romeHour(new Date("2026-11-21T00:30:00Z")), 1, "Nov 00:30Z is 01:30 CET");
  assertEquals(romeHour(new Date("2026-07-01T17:30:00Z")), 19, "Jul 17:30Z is 19:30 CEST");
});

Deno.test("normalizeLiveReadHours fails closed and never widens a malformed window", () => {
  assertEquals(normalizeLiveReadHours(null), [], "null disables paid reads");
  assertEquals(normalizeLiveReadHours(undefined), [], "undefined disables paid reads");
  assertEquals(normalizeLiveReadHours([23, 19, 19, 0]), [0, 19, 23], "dedup + sort");
  assertEquals(normalizeLiveReadHours([19, 24, -1, 2.5, "x"]), [19], "invalid entries dropped");
  assertEquals(normalizeLiveReadHours("19"), [], "non-array disables reads");
});

Deno.test("isLiveReadDue reads only explicitly scheduled venues", () => {
  assert(!isLiveReadDue(null, 4), "null schedule is never due");
  assert(!isLiveReadDue([], 19), "empty schedule is never due");
  assert(isLiveReadDue([19, 20], 20), "hour inside window");
  assert(!isLiveReadDue([19, 20], 21), "hour outside window");
});

// The Porta Venezia test plan (Friday night), as Rome clock hours of each read.
const PORTA_VENEZIA_PLAN: Record<string, number[]> = {
  "Love": [19, 20, 21, 22, 23, 0, 1],
  "Rainbow Café": [19, 20, 21, 22, 23, 0, 1],
  "Red Café": [19, 20, 21, 22, 23, 0, 1],
  "Eppol Pie": [19, 20, 21, 22, 23, 0, 1],
  "Nura": [19, 20, 21, 22, 23, 0, 1],
  "Magutt": [19, 20, 21, 22, 23, 0, 1],
  "Malpighi 8": [19, 20, 21, 22, 23, 0],
  "Eppol": [19, 20, 21, 22, 23, 0],
  "Eroica Caffè": [19, 20, 21, 22, 23, 0],
  "Bar Picchio": [19, 20, 21, 22, 23],
  "Da Oscar": [19, 20, 21, 22],
  "Meydan Istanbul": [0, 1],
};

// UTC instants of the cron runs: '30 18-23 * * 5' + '30 0 * * 6' (CET).
const CRON_RUNS_UTC = [
  "2026-11-20T18:30:00Z",
  "2026-11-20T19:30:00Z",
  "2026-11-20T20:30:00Z",
  "2026-11-20T21:30:00Z",
  "2026-11-20T22:30:00Z",
  "2026-11-20T23:30:00Z",
  "2026-11-21T00:30:00Z",
];

Deno.test("Porta Venezia plan: the seven cron runs make exactly 71 live calls", () => {
  const perRun = CRON_RUNS_UTC.map((instant) => {
    const hour = romeHour(new Date(instant));
    return Object.entries(PORTA_VENEZIA_PLAN)
      .filter(([, hours]) => isLiveReadDue(normalizeLiveReadHours(hours), hour))
      .map(([name]) => name);
  });

  assertEquals(perRun.map((venues) => venues.length), [11, 11, 11, 11, 10, 10, 7], "venues per run");
  const total = perRun.reduce((sum, venues) => sum + venues.length, 0);
  assertEquals(total, 71, "total live calls");

  assert(!perRun[0].includes("Meydan Istanbul"), "Meydan is not read at 19:30");
  assert(perRun[5].includes("Meydan Istanbul"), "Meydan is read at 00:30");
  assert(!perRun[4].includes("Da Oscar"), "Da Oscar is not read at 23:30");
  assert(!perRun[6].includes("Malpighi 8"), "Malpighi 8 is not read at 01:30");
});
