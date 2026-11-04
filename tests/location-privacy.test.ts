import {
  dailyLocationSessionId,
  locationRevocationDays,
} from "../supabase/functions/_shared/location-privacy.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const secret = "private-beta-test-secret-with-32-characters";

Deno.test("location pseudonyms are stable within a UTC day", async () => {
  const first = await dailyLocationSessionId("user-a", new Date("2026-11-04T01:00:00Z"), secret);
  const second = await dailyLocationSessionId("user-a", new Date("2026-11-04T22:00:00Z"), secret);
  assert(first === second, "one user must count as one daily session");
  assert(/^[0-9a-f-]{36}$/.test(first), "the database session key must be UUID-compatible");
});

Deno.test("location pseudonyms differ by user and day", async () => {
  const first = await dailyLocationSessionId("user-a", new Date("2026-11-04T12:00:00Z"), secret);
  const otherUser = await dailyLocationSessionId("user-b", new Date("2026-11-04T12:00:00Z"), secret);
  const nextDay = await dailyLocationSessionId("user-a", new Date("2026-11-05T12:00:00Z"), secret);
  assert(first !== otherUser, "different users must have different pseudonyms");
  assert(first !== nextDay, "the pseudonym must rotate daily");
});

Deno.test("revocation covers both UTC days potentially retained for 24 hours", () => {
  const days = locationRevocationDays(new Date("2026-11-04T00:10:00Z"));
  assert(days.length === 2, "today and yesterday must be removed");
  assert(days[1].toISOString().startsWith("2026-11-03"), "the prior UTC day must be included");
});
