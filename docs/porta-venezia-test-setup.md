# Test BestTime · Porta Venezia (10 venue) — Setup & Readiness

Runbook controllato per avviare il test su 10 locali di Porta Venezia con un
budget massimo di **83 crediti**: 20 per i 10 New Forecast e 63 per le letture
Live. Le 63 letture sono un tetto iniziale: dopo il primo esito live non
disponibile, quella venue viene sospesa e il consumo effettivo diminuisce.

> Aggiornato: 2026-11-27 · Contesto: piano BestTime metered, 10 venue.

> **Blocco di sicurezza:** non registrare venue e non attivare cron finché la
> validazione della chiave non restituisce `ok=true`, `valid=true`,
> `active=true` e i controlli SQL non mostrano 10 venue / 63 live / 83 totali.

> **Guardia per marker:** `crowd-refresh` effettua al massimo una prima prova su
> una venue `pending`. Un risultato live valido la porta a `confirmed`; una
> risposta BestTime valida ma senza dato live la porta a `suspended`. Le venue
> sospese non vengono più interrogate fino a un reset manuale. Timeout, HTTP
> 429, chiave/quota e altri errori globali non sospendono singoli marker.

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

1. **Nessuna cache del forecast BestTime** (`besttime_forecast_slots`). Oggi il pattern settimanale si costruisce **solo** accumulando il live per settimane. Una cache del forecast darebbe la curva settimanale **da subito** (prior etichettato). È un *miglioramento*, non un blocco. Vedi §7.
2. Il progetto staging deve essere creato e configurato seguendo
   [`supabase-staging-test.md`](./supabase-staging-test.md). Lo schema di base,
   inclusa `venue_mappings`, è ora riproducibile tramite migration.

---

## 3. Preflight chiave (nessun forecast/live)

La funzione server-side `besttime-register` espone l'azione
`validate-key`. Interroga `GET /api/v1/keys/{private_key}` e restituisce solo
stato/validità, senza mai esporre le chiavi che BestTime rimanda nel payload.
Questo endpoint non crea forecast e non legge dati live.

```bash
curl -sS -X POST \
  'https://<NUOVO_PROJECT_REF>.supabase.co/functions/v1/besttime-register' \
  -H 'Content-Type: application/json' \
  -H 'x-refresh-secret: <CROWD_PIPELINE_SECRET>' \
  --data '{"action":"validate-key"}'
```

Output obbligatorio prima di procedere:

```json
{"ok":true,"valid":true,"active":true,"status":"OK"}
```

Se il risultato è diverso, fermarsi: non effettuare New Forecast, Live o Venue
Search. La chiave privata deve essere salvata solo come secret
`BESTTIME_PRIVATE_API_KEY` nella funzione Supabase.

## 4. Procedimento per le 10 venue

Per ogni locale scelto servono due identificatori legati tra loro in `venue_mappings`:
- un **place** nel vostro catalogo (`places.fsq_place_id`),
- il **`besttime_venue_id`** del locale su BestTime.

**Step 1 — Usa i 10 locali approvati** elencati in
`scripts/sql/porta-venezia-catalog-and-mappings.sql`.

**Step 2 — Ricavate il `besttime_venue_id`** con `besttime-register`, in due
batch controllati da 8 e 2 locali. Non usare Venue Search: può avviare forecast
aggiuntivi e rendere meno prevedibile il consumo.

Elenco approvato per il test del 27 novembre 2026:

| Locale | Indirizzo di riferimento | Categoria | Letture (ora di Roma) |
| --- | --- | --- | --- |
| Love | Via Melzo 5 | nightlife | 19–01 |
| Rainbow Café Milano | Via Alessandro Tadino 6 | nightlife | 19–01 |
| Red Café | Via Lecco 5 | aperitivo | 19–01 |
| Nura | Via Melzo 21 | aperitivo | 19–01 |
| Magutt | Via Lambro 11 | aperitivo | 19–01 |
| Brolo Milano - Orto con cucina | Via Melzo 19 | food | 19–01 |
| Malpighi 8 | Via Marcello Malpighi 8 | aperitivo | 19–00 |
| Eppol | Via Marcello Malpighi 7 | food | 19–00 |
| Bar Picchio | Via Melzo 11 | aperitivo | 19–23 |
| Ristorante Da Oscar (Porta Venezia) | Via Lazzaro Palazzi 4 | food | 19–22 |

**Step 3 — Verificate che il place esista** nel catalogo:
```sql
select id, name, fsq_place_id, latitude, longitude
from public.places
where name ilike '%<nome locale>%';
```
Se non c'è, fatelo comparire eseguendo `places-discover` sull'area (o inseritelo manualmente in `places`) prima di mapparlo.

**Step 4 — Inserite le `venue_mappings`** (template in §5).

**Step 5 — Verifica** (template in §8).

---

## 5. Registrazione controllata e mapping

> Lo schema di `venue_mappings` è versionato nella migration fondamentale. È
> comunque utile ispezionarlo prima dell'inserimento per evitare errori manuali.

```sql
-- 0) Schema reale della tabella
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'venue_mappings'
order by ordinal_position;
```

```sql
-- 1) Inserimento delle 10 venue (riempite gli ID restituiti da BestTime)
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
on conflict (fsq_place_id) do update
  set besttime_venue_id = excluded.besttime_venue_id,
      live_priority     = excluded.live_priority,
      match_status      = excluded.match_status;
```

> Note:
> - `match_status`: usate il valore già in uso sulle righe esistenti (probabilmente `'matched'`/`'manual'`) — verificatelo con `select distinct match_status from public.venue_mappings;`.
> - Se lo schema ha altre colonne NOT NULL, aggiungetele all'insert (lo step 0 le elenca).
> - Con 10 venue siete ben sotto il limite tecnico di 100 per refresh; il limite economico resta la guardia 63/83.

---

La registrazione va fatta in due batch (massimo 8 venue per richiesta). Ogni
risultato deve essere confrontato con nome e indirizzo richiesti prima di
scrivere il mapping. Un New Forecast riuscito costa 2 crediti; uno non riuscito
può comunque costarne 1, quindi non automatizzare retry ciechi.

La funzione rifiuta una registrazione se non riceve sia
`"action":"register-venues"` sia `confirmedMaxCredits` uguale a due volte il
numero di venue nel batch. Esempio per un batch da 8: `confirmedMaxCredits: 16`;
per il secondo batch da 2: `confirmedMaxCredits: 4`. Questo rende esplicito il
massimo consumo prima di ogni chiamata pagata.

## 6. Schema riproducibile

La migration `202609210000_foundation_schema.sql` crea le tabelle fondamentali
che il primo prototipo aveva creato manualmente, inclusa `venue_mappings`. Un
progetto Supabase vuoto può quindi essere ricostruito con `supabase db push`.

---

## 7. (Opzionale) Cache forecast — tendenze immediate

Oggi i trend emergono solo dopo settimane di accumulo live. Aggiungendo `besttime_forecast_slots` (curva settimanale del *New Forecast* BestTime, **etichettata come forecast, separata dall'osservato**) avreste il pattern settimanale **dal primo giorno**, poi raffinato dal live. È un miglioramento indipendente da tutto il resto.

---

## 8. Verifica (dopo l'inserimento)

```sql
-- Le 10 mappe sono presenti, pianificate e prioritizzate?
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

**Criterio di uscita del test:** quante delle 10 venue forniscono Live verificato,
con quale disponibilità per ora e quante osservazioni vengono archiviate. Una
sola serata non basta a validare il modello settimanale.

> ⚠️ **Una sola notte NON matura i trend.** 7 letture in una sera = 1 campione per slot (venerdì, ora); la maturità richiede ≥12 campioni / ≥3 giorni. Inoltre 70 letture esauriscono la trial. Questo test valida **live-availability, plausibilità e archiviazione (`crowd_history`)** — i trend arrivano con le settimane sul piano a pagamento.

---

## 9. Configurazione cron della serata di test

Durante la trial il live va letto **solo quando ogni locale è aperto**, non ogni 20 min. Ogni venue ha la sua finestra in `venue_mappings.live_read_hours` (ore di Roma); `crowd-refresh` legge solo le venue la cui finestra contiene l'ora corrente.

- **Script:** [`porta-venezia-venue-schedule.sql`](../scripts/sql/porta-venezia-venue-schedule.sql) (orari per venue + controlli di budget) e [`porta-venezia-test-cron.sql`](../scripts/sql/porta-venezia-test-cron.sql) (cron).
- **Esecuzioni:** venerdì 19:30 → sabato 01:30, alle **:30** di ogni ora = 7 esecuzioni.
- **Letture per esecuzione:** 10 · 10 · 10 · 10 · 9 · 8 · 6 = **63 live**. Con 10 registrazioni × 2 crediti = **83 crediti massimi**.
- **`forceProvider` obbligatorio:** la pipeline chiama BestTime solo nei primi 5 minuti dell'ora; alle :30 il cron passa `{"forceProvider": true, "forceWeather": true}`.
- **Guardia di budget:** NULL, valori malformati e array vuoti falliscono chiusi; il controllo deve restituire **0** venue senza orario.
- **Fuso:** pg_cron gira in **UTC** → `30 18-23 * * 5` + `30 0 * * 6`. Se `show timezone;` dà `Europe/Rome`, usa `30 19-23 * * 5` + `30 0-1 * * 6`.

### Checklist entro le 19:30
1. Validata la chiave con `{"action":"validate-key"}`; nessuna chiamata pagata eseguita prima dell'esito positivo.
2. Confermato a schermo il budget: **10 venue, 63 live, 20 forecast, 83 totale**.
3. Registrate le 10 venue su BestTime (New Forecast, massimo 2 crediti l'una) → 10 `besttime_venue_id`; verificati nome, indirizzo e coordinate restituiti.
4. Applicate le migration `202611260020_venue_live_read_hours_fail_closed.sql`
   e `202611270022_besttime_per_venue_credit_guard.sql`.
5. **Ri-deployate** `besttime-register` e `crowd-refresh`.
6. Inserite le 10 `venue_mappings`, poi eseguito `porta-venezia-venue-schedule.sql`: controlli = **0** senza orario, **10** venue, **63** letture.

### Controllo e riattivazione manuale

Durante il test, controllare quali marker sono stati esclusi:

```sql
select besttime_name, live_availability_status, live_suspended_at,
       live_suspension_reason
from public.venue_mappings
where besttime_venue_id is not null
order by live_availability_status, besttime_name;
```

BestTime specifica che l'assenza di live può dipendere dal momento della
giornata. Per riprovare una venue in un test futuro serve quindi una scelta
esplicita, mai un retry automatico:

```sql
update public.venue_mappings
set live_availability_status = 'pending',
    live_suspended_at = null,
    live_suspension_reason = null,
    updated_at = now()
where besttime_venue_id = '<BESTTIME_VENUE_ID_DA_RIATTIVARE>';
```
7. Solo ora eseguito `porta-venezia-test-cron.sql`.
8. Dopo la prima esecuzione (19:30): `crowd_provider_runs` deve mostrare `requested_count = 11` e `metadata.romeHour = 19`.

Nel file cron va sostituito `<TEST_FRIDAY_YYYY-MM-DD>` con la data locale della
serata scelta. La guardia rende i job inerti fuori da quella singola notte.

### Dopo il test
Esegui la sezione REVERT dello script. **Non** riattivare la pipeline 20-min finché non sei sul piano a pagamento (crediti trial finiti).
