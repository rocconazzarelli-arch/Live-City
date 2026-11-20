# Test BestTime · Porta Venezia (10 venue) — Setup & Readiness

Guida per avviare il test a 10 venue su Porta Venezia con l'abbonamento **Basic** di BestTime.
I locali li scegliete voi: qui c'è solo il procedimento e il **template SQL** da riempire.

> Data: 2026-11-20 · Contesto: abbonamento Basic (metered), 10 venue, zona Porta Venezia.

---

## 1. Stato di readiness — cosa è GIÀ pronto ✅

L'architettura Supabase **archivia già** i dati BestTime in modo durevole e produce tendenze settimanali. In particolare:

| Pezzo | Stato | Dove |
| --- | --- | --- |
| Pipeline schedulata (ogni 20 min): `crowd-refresh` (live) → `crowd-engine-refresh` | ✅ | `crowd-pipeline-refresh`, pg_cron `live-city-crowd-pipeline-every-20-minutes` |
| Archivio **durevole** delle osservazioni (nessuna retention breve) | ✅ | tabella `crowd_history` (upsert per `place_id,bucket_start`, salva `besttime_score` + `besttime_observed_at`) |
| Aggregazione notturna in slot giorno×ora su **finestra 90 giorni** | ✅ | `refresh_crowd_historical_slots()` legge da `crowd_history`, dedup BestTime per `observed_at`, soglie **12 campioni / 3 giorni distinti** |
| Provenienza (live / stima / non disponibile) e osservabilità | ✅ | `venue_crowd_cache.observation_mode`, `crowd_provider_runs` |
| Privacy telemetria (≥5 sessioni) | ✅ | vincolo su `crowd_history` |

**Conseguenza:** una volta mappate le venue, il sistema accumula le osservazioni live giorno dopo giorno e, raggiunta la maturità (≥12 campioni su ≥3 giorni per slot), inizia a produrre i trend settimanali. Nessun intervento di archiviazione è necessario.

---

## 2. Gap reali rimasti

1. **`venue_mappings` non è creata da nessuna migration del repo.** Esiste solo sul progetto Supabase remoto collegato. Un ambiente pulito/CI non la ricreerebbe → va aggiunta una migration `create table if not exists` ricostruita dallo schema remoto (vedi §5). Non blocca il test sul remoto esistente, ma è un debito da chiudere.
2. **Nessuna cache del forecast BestTime** (`besttime_forecast_slots`). Oggi il pattern settimanale si costruisce **solo** accumulando il live per settimane. Una cache del forecast darebbe la curva settimanale **da subito** (prior etichettato). È un *miglioramento*, non un blocco. Vedi §6.

---

## 3. Procedimento per le 10 venue (le scegliete voi)

Per ogni locale scelto servono due identificatori legati tra loro in `venue_mappings`:
- un **place** nel vostro catalogo (`places.fsq_place_id`),
- il **`besttime_venue_id`** del locale su BestTime.

**Step 1 — Scegliete i 10 locali** a Porta Venezia (box indicativo lat 45.470–45.482 · lng 9.198–9.215).

**Step 2 — Ricavate il `besttime_venue_id`** per ciascuno: con la *Venue Search/Filter* di BestTime (nome + indirizzo, o filtro sul box). Annotate l'id restituito.

**Step 3 — Verificate che il place esista** nel catalogo:
```sql
select id, name, fsq_place_id, latitude, longitude
from public.places
where name ilike '%<nome locale>%';
```
Se non c'è, fatelo comparire eseguendo `places-discover` sull'area (o inseritelo manualmente in `places`) prima di mapparlo.

**Step 4 — Inserite le `venue_mappings`** (template in §4).

**Step 5 — Verifica** (template in §7).

---

## 4. Template SQL — inserimento `venue_mappings`

> ⚠️ `venue_mappings` non è nel repo: **prima ispezionate lo schema reale** per conoscere colonne obbligatorie e chiave di conflitto.

```sql
-- 0) Schema reale della tabella
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'venue_mappings'
order by ordinal_position;
```

```sql
-- 1) Inserimento delle 10 venue (riempite i placeholder con i VOSTRI locali)
--    live_priority: 0–100, più alto = aggiornato prima nel refresh live.
insert into public.venue_mappings (fsq_place_id, besttime_venue_id, live_priority, match_status)
values
  ('<FSQ_PLACE_ID_01>', '<BESTTIME_VENUE_ID_01>', 90, 'matched'),
  ('<FSQ_PLACE_ID_02>', '<BESTTIME_VENUE_ID_02>', 90, 'matched'),
  ('<FSQ_PLACE_ID_03>', '<BESTTIME_VENUE_ID_03>', 90, 'matched'),
  ('<FSQ_PLACE_ID_04>', '<BESTTIME_VENUE_ID_04>', 90, 'matched'),
  ('<FSQ_PLACE_ID_05>', '<BESTTIME_VENUE_ID_05>', 90, 'matched'),
  ('<FSQ_PLACE_ID_06>', '<BESTTIME_VENUE_ID_06>', 90, 'matched'),
  ('<FSQ_PLACE_ID_07>', '<BESTTIME_VENUE_ID_07>', 90, 'matched'),
  ('<FSQ_PLACE_ID_08>', '<BESTTIME_VENUE_ID_08>', 90, 'matched'),
  ('<FSQ_PLACE_ID_09>', '<BESTTIME_VENUE_ID_09>', 90, 'matched'),
  ('<FSQ_PLACE_ID_10>', '<BESTTIME_VENUE_ID_10>', 90, 'matched')
on conflict (<chiave_reale>) do update       -- es. (fsq_place_id) — confermate con lo step 0
  set besttime_venue_id = excluded.besttime_venue_id,
      live_priority     = excluded.live_priority,
      match_status      = excluded.match_status;
```

> Note:
> - `match_status`: usate il valore già in uso sulle righe esistenti (probabilmente `'matched'`/`'manual'`) — verificatelo con `select distinct match_status from public.venue_mappings;`.
> - Se lo schema ha altre colonne NOT NULL, aggiungetele all'insert (lo step 0 le elenca).
> - Con 10 venue siete ben sotto il limite di 100 per refresh.

---

## 5. (Debito) Migration per `venue_mappings`

Per chiudere il gap di riproducibilità, va committata una `create table if not exists public.venue_mappings (...)` **identica allo schema remoto**. Il modo sicuro è generarla dal remoto collegato:

```bash
supabase db pull
```

(oppure `supabase db dump --schema public` e isolare la sezione `venue_mappings`). Così la definizione autentica entra nelle migration senza indovinare colonne/vincoli.

---

## 6. (Opzionale) Cache forecast — tendenze immediate

Oggi i trend emergono solo dopo settimane di accumulo live. Aggiungendo `besttime_forecast_slots` (curva settimanale del *New Forecast* BestTime, **etichettata come forecast, separata dall'osservato**) avreste il pattern settimanale **dal primo giorno**, poi raffinato dal live. È un miglioramento indipendente da tutto il resto.

---

## 7. Verifica (dopo l'inserimento)

```sql
-- Le 10 mappe sono presenti e prioritizzate?
select fsq_place_id, besttime_venue_id, live_priority, match_status
from public.venue_mappings
order by live_priority desc nulls last;
```

```sql
-- Dopo ~1 ora: il live sta arrivando in cache?
select besttime_venue_id, crowd_score, observation_mode, fetched_at, expires_at
from public.venue_crowd_cache
order by fetched_at desc
limit 20;
```

```sql
-- Ogni run della pipeline è andato a buon fine?
select started_at, requested_count, live_written_count, unavailable_count, failure_count, status
from public.crowd_provider_runs
order by started_at desc
limit 10;
```

```sql
-- Dopo ~1 giorno: l'archivio durevole accumula osservazioni BestTime?
select place_id, count(*) filter (where besttime_score is not null) as besttime_points,
       min(bucket_start) as first_seen, max(bucket_start) as last_seen
from public.crowd_history
group by place_id
order by besttime_points desc
limit 20;
```

```sql
-- Dopo ~3+ giorni: gli slot maturano (≥12 campioni / ≥3 giorni) → trend settimanali?
select place_id, local_weekday, local_hour, average_score,
       sample_count, distinct_days, besttime_samples
from public.crowd_historical_slots
where sample_count >= 12 and distinct_days >= 3
order by place_id, local_weekday, local_hour;
```

**Criterio di uscita del test:** quante delle 10 venue raggiungono righe mature in `crowd_historical_slots` entro 1–2 settimane, e con quale **live-availability** (campioni BestTime reali) → decide se BestTime per voi è "live diffuso" o solo forecast, e quale tier sottoscrivere.

> ⚠️ **Una sola notte NON matura i trend.** 7 letture in una sera = 1 campione per slot (venerdì, ora); la maturità richiede ≥12 campioni / ≥3 giorni. Inoltre 70 letture esauriscono la trial. Questo test valida **live-availability, plausibilità e archiviazione (`crowd_history`)** — i trend arrivano con le settimane sul piano a pagamento.

---

## 8. Configurazione cron della serata di test

Durante la trial il live va letto **solo quando ogni locale è aperto**, non ogni 20 min. Ogni venue ha la sua finestra in `venue_mappings.live_read_hours` (ore di Roma); `crowd-refresh` legge solo le venue la cui finestra contiene l'ora corrente.

- **Script:** [`porta-venezia-venue-schedule.sql`](../scripts/sql/porta-venezia-venue-schedule.sql) (orari per venue + controlli di budget) e [`porta-venezia-test-cron.sql`](../scripts/sql/porta-venezia-test-cron.sql) (cron).
- **Esecuzioni:** venerdì 19:30 → sabato 01:30, alle **:30** di ogni ora = 7 esecuzioni.
- **Letture per esecuzione:** 12 · 12 · 12 · 12 · 10 · 10 · 7 = **75 live**. Con 13 registrazioni × 2cr = **101 crediti** → oltre i ~100 della trial: togli almeno una lettura.
- **`forceProvider` obbligatorio:** la pipeline chiama BestTime solo nei primi 5 minuti dell'ora; alle :30 il cron passa `{"forceProvider": true, "forceWeather": true}`.
- **Guardia di budget:** una venue con `live_read_hours` NULL viene letta a ogni esecuzione. Il controllo nello script deve restituire **0** venue senza orario.
- **Fuso:** pg_cron gira in **UTC** → `30 18-23 * * 5` + `30 0 * * 6`. Se `show timezone;` dà `Europe/Rome`, usa `30 19-23 * * 5` + `30 0-1 * * 6`.

### Checklist entro le 19:30
1. Registrate le 13 venue su BestTime (New Forecast, 2cr l'una) → 13 `besttime_venue_id`. Verificate prima su Google **Popular Times + orari di apertura**.
2. Applicata la migration `202611200019_venue_live_read_hours.sql`.
3. **Ri-deployata** l'edge function: `supabase functions deploy crowd-refresh`.
4. Inserite le 13 `venue_mappings` (§4), poi eseguito `porta-venezia-venue-schedule.sql`: controlli = **0** senza orario, **13** venue, **75** letture.
5. Eseguito `porta-venezia-test-cron.sql`.
6. Dopo la prima esecuzione (19:30): `crowd_provider_runs` deve mostrare `requested_count = 12` e `metadata.romeHour = 19`.

### Dopo il test
Esegui la sezione REVERT dello script. **Non** riattivare la pipeline 20-min finché non sei sul piano a pagamento (crediti trial finiti).
