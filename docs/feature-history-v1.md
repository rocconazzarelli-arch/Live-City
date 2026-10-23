# LIVE CITY — storico delle feature (passo 1 del modello predittivo)

## Obiettivo

Il modello predittivo e il clustering delle aggregazioni hanno bisogno di storico: pattern giornalieri, settimanali e stagionali si imparano solo da dati accumulati nel tempo. Questo passo non cambia il calcolo del Crowd Score né l'app: inizia a **salvare** ciò che serve.

## Cosa viene salvato

| Tabella | Granularità | Contenuto |
|---|---|---|
| `weather_observations` | 1 riga per ora per località (V1: `milano`, Duomo) | temperatura, temperatura percepita, umidità, precipitazioni, pioggia, nuvolosità, vento, codice meteo WMO, giorno/notte, minuti di sole |
| `crowd_history` | 1 riga per luogo ogni 20 minuti | Crowd Score finale e tutti i segnali usati: previsione storica, BestTime (valore, ora di osservazione, stale), telemetria aggregata, boost eventi, fallback |

Il meteo ha un campo `data_kind` con precedenza `forecast < analysis < reanalysis`: una previsione non sovrascrive mai un dato già osservato, e nulla sovrascrive la rianalisi storica. La regola vive nella funzione SQL `upsert_weather_observations`.

`crowd_history` contiene solo aggregati per luogo. La telemetria compare solo sopra la soglia privacy di 5 sessioni, imposta anche da un vincolo del database. Entrambe le tabelle hanno RLS attivo e nessuna policy client.

I luoghi senza alcun segnale (`isUnavailable`) non vengono scritti: il loro punteggio 0 è un segnaposto e insegnerebbe al modello un affollamento mai osservato.

BestTime non fornisce lo storico del dato live: viene ricostruito da `crowd_history`. Poiché la pipeline riusa la stessa lettura BestTime per più refresh, il modello deve deduplicare con `besttime_observed_at`.

La strategia Hybrid (`hybrid_crowd_estimates`) per ora non viene storicizzata.

### Perché non basta `crowd_signals`

`refresh_crowd_historical_slots()` calcola le medie su 90 giorni leggendo `crowd_signals`, ma `purge_expired_location_telemetry()` elimina quei segnali 24 ore dopo `valid_until`. In pratica gli slot storici vedono solo uno o due giorni di dati e difficilmente raggiungono la soglia di 12 campioni su 3 giorni. `crowd_history` non ha questa retention: un passo successivo può far leggere gli slot da qui (deduplicando BestTime con `besttime_observed_at`).

## Flusso

```text
pg_cron ogni 20 min ──► crowd-pipeline-refresh
                          ├─ crowd-refresh      (BestTime, 1 volta/ora)
                          ├─ area-heatmap-refresh (telemetria k-anonima)
                          ├─ weather-ingest     (Open-Meteo, 1 volta/ora)  ◄─ nuovo
                          └─ crowd-engine-refresh
                                 ├─ crowd_estimates (come prima)
                                 └─ crowd_history                          ◄─ nuovo
```

Un errore del meteo o della scrittura dello storico non blocca il calcolo delle stime: compare nella risposta (`weather`, `stats.historyError`).

## Deploy

1. Applicare la migrazione: `npx supabase db push` (`202610230014_feature_history_weather.sql`).
2. Pubblicare le funzioni: `npx supabase functions deploy weather-ingest crowd-engine-refresh crowd-pipeline-refresh`.
3. Primo caricamento meteo recente (2 giorni passati + 3 di previsione):

   ```bash
   curl -X POST "https://qmskozzidachccwbtejd.supabase.co/functions/v1/weather-ingest" \
     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
     -H "Content-Type: application/json" \
     -d '{"mode":"recent"}'
   ```

4. Backfill storico, al massimo 366 giorni per chiamata. Consigliato dal 2023 per avere più stagioni:

   ```bash
   for range in "2023-01-01 2023-12-31" "2024-01-01 2024-12-31" "2025-01-01 2025-12-31" "2026-01-01 2026-10-15"; do
     set -- $range
     curl -X POST "https://qmskozzidachccwbtejd.supabase.co/functions/v1/weather-ingest" \
       -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
       -H "Content-Type: application/json" \
       -d "{\"mode\":\"backfill\",\"startDate\":\"$1\",\"endDate\":\"$2\"}"
   done
   ```

   L'archivio Open-Meteo è in ritardo di alcuni giorni: le ore non ancora disponibili vengono saltate e coperte dal refresh orario.

5. Verificare dopo un'ora di pipeline:

   ```sql
   select data_kind, count(*), min(observed_at), max(observed_at)
   from weather_observations group by data_kind;

   select bucket_start, count(*), count(besttime_score) as with_besttime
   from crowd_history group by bucket_start order by bucket_start desc limit 6;
   ```

## Licenza Open-Meteo

L'API gratuita di Open-Meteo è riservata all'uso non commerciale (con limiti giornalieri di chiamate). Con il lancio commerciale serve un piano a pagamento: basta impostare il secret `OPEN_METEO_API_KEY` e la funzione passa agli host `customer-*` senza modifiche al codice. Prima del lancio va verificato sul sito di Open-Meteo.

## Crescita dei dati

Con 300 luoghi, `crowd_history` cresce di circa 21.600 righe al giorno (circa 8 milioni l'anno), gestibili con l'indice per `bucket_start`. Oltre qualche decina di milioni di righe conviene partizionare per mese o spostare i mesi chiusi in un archivio per il training.

## Prossimo passo

Spostare `refresh_crowd_historical_slots()` su `crowd_history`; poi profili attesi per luogo, giorno, ora, meteo e calendario; rilevazione delle anomalie (osservato − atteso); celle H3 e clustering delle aggregazioni.
