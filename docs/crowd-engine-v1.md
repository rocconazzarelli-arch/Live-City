# Crowd Engine V2 — osservazioni e storico

## Scope

Il motore usa il dato BestTime live fresco o la telemetria LIVE CITY aggregata come valore corrente. Quando nessuno dei due è disponibile, può produrre una previsione soltanto dallo storico di osservazioni reali dello stesso luogo, nella stessa ora e giorno locale. Non esiste più un profilo fisso per categoria.

The remote schema inspected on 22 September 2026 contained 101 places, 42 mapping rows, 19 cache rows, one event, and empty `crowd_signals`/`crowd_estimates` tables. The migration therefore completes the existing prototype tables in place and retains their legacy columns.

## Formula

For each place:

1. Se il cached BestTime è finito, disponibile e fresco, è il segnale live principale. Una riga scaduta pesa meno e viene scartata dopo 24 ore. `999`, null, chiuso o valori invalidi vengono ignorati.
2. La telemetria opt-in contribuisce solo sopra 5 sessioni aggregate e nella finestra di freschezza.
3. Senza segnale live, `crowd_historical_slots` fornisce una previsione solo con almeno 12 osservazioni reali in 3 giorni, per il medesimo luogo/ora/giorno Europe/Rome.
4. Un evento aggiunge un boost prudente. La stima combina i segnali disponibili, senza mai generare un valore da un profilo generico.
5. Derive activity: `low < 25`, `medium < 50`, `high < 75`, otherwise `very_high`.
6. Compare with the previous estimate: `up` at `+8` or more, `down` at `-8` or less, otherwise `stable`.

Una previsione storica è marcata `metadata.isFallback = true`; se non c'è né live né storico idoneo, è marcata `metadata.isUnavailable = true` e il client restituisce “Dato non disponibile”. Ogni stima registra contributi e versione formula. Le stime scadono dopo 30 minuti.

## Provenienza verificabile

- La tabella cache conserva `observation_mode`: solo `live` viene trasformato in un segnale BestTime corrente.
- `forecast` e `unknown` vengono esclusi sia dal motore sia dal fallback dell'API pubblica. Le righe cache preesistenti partono da `unknown`.
- L'adapter `crowd-refresh` deve scrivere `observation_mode = 'live'` soltanto dopo una risposta riuscita dall'endpoint BestTime Live; una risposta forecast deve scrivere `forecast` o essere ignorata.
- Le tabelle `crowd_historical_slots` sono alimentate unicamente da segnali `observed` BestTime Live e telemetria LIVE CITY aggregata, deduplicati per sorgente e timestamp. Non ricevono previsioni o eventi.

## Failure behaviour

- The refresh function never contacts BestTime, so quota exhaustion and provider downtime cannot prevent a refresh.
- Missing, invalid, `999`, forecast, unknown, or older-than-24-hours provider rows are ignored.
- In their absence the engine may use only a sufficiently sampled observed-history slot; otherwise it returns unavailable.
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

During rollout, only a usable `observation_mode = 'live'` row from `venue_crowd_cache` can be used if no engine estimate exists. The iPhone UI translates technical provenance into only `Dato live`, `Stima`, or `Dato non disponibile`.

## Deployment order

1. Apply `supabase/migrations/202609220001_crowd_engine_v1.sql` and `supabase/migrations/202609230005_observed_history_predictions.sql`.
2. Update the provider adapter so that only BestTime Live responses write `observation_mode = 'live'`; keep its quota at 100 priority venues/hour.
3. Deploy `crowd-engine-refresh` and `places-read`, then invoke the engine once.
4. Confirm engine stats distinguish `bestTimeSignals`, `telemetrySignals`, `historicalPredictionSignals`, and unavailable estimates.
5. After at least 12 observed samples across 3 days in the same slot, confirm a historical prediction is labelled `Stima`; otherwise confirm the API returns `Dato non disponibile`.

## BestTime Live adapter

`crowd-refresh` calls `POST https://besttime.app/api/v1/forecasts/live` server-side with an existing `venue_id`. It accepts a score only when `analysis.venue_live_busyness_available = true` and writes that row with `observation_mode = 'live'` and a one-hour expiry. The related forecast value is deliberately discarded.

The function requires `BESTTIME_PRIVATE_API_KEY` only in Supabase Edge Function secrets; it must never be copied into Expo variables or the client. It accepts only service-role calls from `crowd-pipeline-refresh`, enforces a limit of 100 venue requests, and reads the highest `venue_mappings.live_priority` rows first.

The map renders up to 30 individual places per category (150 at most with
`Tutti`). Presentation and provider capacity are intentionally separate: the
priority migration reserves 20 BestTime Live requests per category, keeping
the hourly provider budget at 100. The remaining visible places can show only
LIVE CITY aggregate telemetry, a clearly labelled historical prediction, or
`Dato non disponibile`.

## Next architecture slice

Supabase Auth, profiles, event ownership/moderation, and verified business claims remain a separate milestone. Event creation should later add `created_by`, publication state, and owner-scoped RLS. A business claim must stay pending until a real verification process completes; role assignment alone must never prove ownership.
