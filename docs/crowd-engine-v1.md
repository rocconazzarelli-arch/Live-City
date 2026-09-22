# Crowd Engine V1

## Scope

Crowd Engine V1 produces one current estimate for every active Milan place without making provider calls. It combines the last usable BestTime cache entry, an event contribution, and a deterministic category/day/hour fallback. Raw inputs are stored in `crowd_signals`; the public map reads only aggregate rows in `crowd_estimates` through `places-read`.

The remote schema inspected on 22 September 2026 contained 101 places, 42 mapping rows, 19 cache rows, one event, and empty `crowd_signals`/`crowd_estimates` tables. The migration therefore completes the existing prototype tables in place and retains their legacy columns.

## Formula

For each place:

1. Generate a Europe/Rome category/hour baseline with confidence `0.30` and weight `0.35`. The editable configuration is `TEMPORAL_PROFILES` in `_shared/crowd-engine.ts`.
2. If the cached BestTime score is finite and in `0...100`, add it as the main signal. A cache row that has not expired has weight `1.0`; an expired row decays from `0.55` and is discarded after 24 hours. `999`, null, closed/unavailable values, invalid timestamps, and out-of-range values are ignored.
3. An active directly linked event adds 18 points. An event starting within four hours adds 4–12 points according to proximity. For an event without `place_id`, geographic matching first looks for the same category within 250 metres; an exact-neighbour fallback may then match any category within 120 metres. Geographic boosts and confidence are reduced by 45%.
4. Compute the weighted mean of BestTime and temporal signals, then add event boosts. Combined event contribution is capped at 25 points. Clamp the result to `0...100`.
5. Derive activity: `low < 25`, `medium < 50`, `high < 75`, otherwise `very_high`.
6. Compare with the previous estimate: `up` at `+8` or more, `down` at `-8` or less, otherwise `stable`.

A result without a usable BestTime signal is marked `metadata.isFallback = true` and never presented as live data. Every estimate records its signal contributions and formula version in metadata. Estimates expire after 30 minutes.

## Verified rollout (22 September 2026)

- The additive migration was applied to the live project and RLS is enabled on both Crowd Engine tables.
- A live refresh read 101 places, wrote 101 temporal signals, and upserted 101 current estimates.
- None of the 19 mapped BestTime cache rows was still usable, so all 101 results were honestly marked as low-confidence fallback estimates.
- The public `places-read` endpoint returned HTTP 200 with 101 places, 101 available estimates, and zero unavailable places.
- `events-read` returned the active `LIVE CITY Test Night` event at the Darsena. Its `place_id` is null and no catalogue place falls inside the conservative geographic matching radius, so it remains visible on the map without being incorrectly attributed to a venue score.

## Failure behaviour

- The refresh function never contacts BestTime, so quota exhaustion and provider downtime cannot prevent a refresh.
- Missing, invalid, `999`, or older-than-24-hours provider rows fall back to the temporal profile.
- Stale provider rows retain their original observation time and receive reduced weight/confidence.
- An event cannot independently force a score to 100.
- A failed database read or write returns a non-2xx response and does not claim success.
- `crowd_signals` has RLS enabled and no client read policy. `crowd_estimates` exposes only non-expired aggregate rows; backend functions use the service role.

## API compatibility

`places-read` preserves `crowdScore`, `activityLevel`, `trend`, and `confidence`. It adds:

- `crowdSource`
- `crowdUpdatedAt`
- `crowdValidUntil`
- `crowdIsFallback`
- `crowdDataState` (`fresh`, `stale`, `fallback`, `unavailable`)
- `signalCount`

During rollout, a usable row from `venue_crowd_cache` remains the fallback if no engine estimate exists. The iPhone UI translates technical provenance into only `Dato live`, `Stima`, or `Dato non disponibile`.

## Deployment order

1. Apply `supabase/migrations/202609220001_crowd_engine_v1.sql`.
2. Deploy `crowd-engine-refresh`, `places-read`, and `events-read`.
3. Optionally configure `CROWD_ENGINE_REFRESH_SECRET` for scheduled refreshes. Never expose it to Expo. Calls must also satisfy the function's JWT setting; a service-role bearer token is accepted directly.
4. Invoke `crowd-engine-refresh` once and confirm `stats.placesRead = 101` and `stats.estimatesWritten = 101`.
5. Call `places-read` with the publishable key and confirm all 101 places have a score, with fallback estimates clearly marked.
6. Schedule the refresh about every 30 minutes after the deployment is verified.

## Next architecture slice

Supabase Auth, profiles, event ownership/moderation, and verified business claims remain a separate milestone. Event creation should later add `created_by`, publication state, and owner-scoped RLS. A business claim must stay pending until a real verification process completes; role assignment alone must never prove ownership.
