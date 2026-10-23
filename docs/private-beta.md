# LIVE CITY — private beta readiness

## What is real in this build

- The map reads the remotely deployed catalog, crowd estimates and public
  k-anonymous area snapshots.
- Every 20-minute run first creates those k-anonymous area snapshots, then
  derives venue estimates only from the matching coarse area cell. The engine
  never reads device observations directly.
- A live crowd value is accepted only when BestTime explicitly flags it as live.
- A crowd forecast is published only from historical observed data: at least 12
  samples across three distinct calendar days for the requested Europe/Rome
  weekday and hour.

## Opt-in location contribution

The map works without location permission. A person must deliberately select
**Contribuisci alla mappa live** before the app asks iOS/Android for foreground
location access.

For the private beta, the mobile client converts each location locally to a
0.004° grid cell (roughly 440m north/south in Milan) before the network call.
The endpoint accepts only the cell key, a random per-contribution session ID,
measurement accuracy, timestamp and consent version. It rejects raw latitude
and longitude fields. The database stores the cell centre, not the GPS fix.

Raw contribution rows expire within 24 hours. A cell is visible in the heatmap
only after at least five distinct random sessions contribute in a 20-minute
window. No client can read raw contribution rows.

## TestFlight gate

Before enabling a wider beta:

1. Run `npx eas-cli@latest init` while logged into the intended Expo account.
   This creates and records the EAS project; it is intentionally not created
   automatically.
2. Verify that `com.rocconazzarelli.livecity` is the intended iOS bundle ID and
   Android package before the first cloud build. Changing it later creates a
   different application identity.
3. Deploy migration `202610080011_private_beta_privacy_and_observability.sql`
   and functions `location-ingest`, `area-heatmap-refresh`, `crowd-pipeline-refresh`,
   `crowd-engine-refresh`, `crowd-refresh`, and `app-health`.
4. Use a native development build or TestFlight build on physical devices.
   Expo Go cannot run background location; this beta intentionally uses only
   foreground contribution.
5. Confirm the privacy policy, consent copy, data-retention period and support
   contact with legal/privacy review before inviting testers.
6. Monitor the `app-health` endpoint and `crowd_provider_runs` for BestTime
   freshness, quota failures, opted-in contribution volume and forecast-ready
   historical slots.

## Build profiles

`eas.json` defines three channels:

- `development`: a development client for local testing on a registered
  physical device;
- `preview`: internal-distribution build for a small tester group;
- `production`: release build after App Store and privacy readiness checks.

## Non-goals for this beta

- No background location collection.
- No precise GPS storage or transmission.
- No simulated heatmap cells in the production experience.
- No claim that a forecast is live data.
