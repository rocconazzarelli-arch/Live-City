# LIVE CITY — previsioni crowd corrette dal meteo

## Principio

Il meteo non misura persone. LIVE CITY lo usa esclusivamente per correggere la
baseline storica di un luogo nelle prossime tre ore:

```text
previsione = baseline luogo/giorno/ora + correzione meteo appresa
```

BestTime Live, telemetria aggregata e transazioni Mastercard continuano a
contribuire alla lettura corrente con la propria provenienza. Il forecast
meteo non modifica quella lettura e non la rende “live”.

## Feature

Le osservazioni Open-Meteo vengono trasformate in condizioni interpretabili:

- pioggia e pioggia intensa;
- caldo o freddo percepito;
- vento forte;
- meteo favorevole per attività esterne.

Gli effetti cold-start sono diversi per `outdoor`, `aperitivo`, `food`,
`nightlife` e `culture`. Sono limitati tra -25 e +15 punti per evitare che il
meteo domini la baseline.

## Apprendimento gerarchico

Ogni notte `refresh_weather_crowd_profiles()` confronta il Crowd Score
osservato con la baseline dello stesso luogo, giorno della settimana e ora.
Usa soltanto righe non-fallback con BestTime Live o telemetria LIVE CITY;
eventi dichiarati e previsioni non diventano target di training.

Ordine di preferenza:

1. profilo del luogo: almeno 30 finestre e 7 giorni;
2. profilo della categoria: almeno 60 finestre e 10 giorni;
3. prior cold-start conservativo.

Un singolo effetto meteo viene appreso solo con almeno 8 campioni distribuiti
su 3 giorni. I coefficienti giovani sono ridotti verso il prior, così una
settimana anomala non può invertire improvvisamente il modello.

## Contratto API

Ogni elemento `crowdForecast` restituito da `places-read` include:

- `score`: previsione finale;
- `baselineScore`: previsione storica prima del meteo;
- `weatherAdjustment`: punti aggiunti o sottratti;
- `weatherSummary`: spiegazione breve;
- `weatherModel`: `learned_place`, `learned_category`, `cold_start` o `neutral`;
- `weatherDataKind`: provenienza forecast/analysis/reanalysis;
- `sampleCount` e `distinctDays`: evidenza della baseline.

La confidenza viene ridotta quando la correzione usa il cold start e cresce
solo con profili appresi e baseline sufficientemente mature.

## Operatività

1. Eseguire le migrazioni fino alla `202610270016`.
2. Pubblicare `weather-ingest`, `crowd-pipeline-refresh`,
   `crowd-engine-refresh`, `places-read` e `app-health`.
3. Caricare il meteo recente e, se consentito dal piano Open-Meteo, il backfill
   descritto in `feature-history-v1.md`.
4. Eseguire una prima volta:

   ```sql
   select public.refresh_crowd_historical_slots();
   select public.refresh_weather_crowd_profiles();
   ```

5. Verificare `app-health.weather` e confrontare con backtest temporali la MAE
   del modello corretto rispetto alla sola baseline.

Il profilo cold-start rende subito visibile il comportamento, ma una
correzione viene considerata appresa soltanto dopo le soglie indicate sopra.
