# LIVE CITY — runbook di rilascio

Questo repository è predisposto per un rilascio progressivo. Non contrassegnare mai un dato come live finché tutti i controlli della fase corrispondente non sono verdi.

## 1. Pubblicare il backend

Autenticarsi nel progetto Supabase corretto, quindi applicare le migrazioni in ordine e distribuire le funzioni:

```sh
npx supabase login
npx supabase link --project-ref qmskozzidachccwbtejd
npx supabase db push
npx supabase functions deploy places-read events-read location-ingest area-heatmap-read area-heatmap-refresh app-health
npx supabase functions deploy crowd-refresh crowd-engine-refresh crowd-pipeline-refresh
npx supabase functions deploy mobility-source-refresh hybrid-crowd-refresh
npx supabase functions deploy weather-ingest mastercard-transaction-ingest mastercard-transaction-refresh
```

Il deploy è deliberatamente separato dal client: senza un access token Supabase autorizzato non deve essere eseguito da una macchina di sviluppo.

## 2. Configurare le sorgenti reali

Impostare solo nei secret Supabase, mai in `.env` del client:

- `BESTTIME_PRIVATE_API_KEY` — chiave privata BestTime;
- `MASTERCARD_INGEST_SECRET` — autentica il gateway Mastercard verificato;
- `MASTERCARD_TRANSACTION_HASH_SALT` — pseudonimizza i riferimenti delle
  transazioni prima della persistenza temporanea;
- `CROWD_PIPELINE_SECRET` — segreto usato dal job pianificato;
- `OPEN_METEO_API_KEY` — necessario per uso commerciale e backfill sul piano
  Open-Meteo appropriato; in sviluppo la funzione può usare l'endpoint free;
- variabili standard `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` gestite dall'ambiente Edge Function.

La publishable key resta l'unico valore Supabase nel client. Prima di esporre BestTime, verificare che la pipeline selezioni al massimo 100 venue con `live_priority`, al massimo una volta ogni ora.

## 3. Audit Milano (prima del pubblico)

Per almeno sette giorni raccogliere e verificare:

- percentuale di venue BestTime con osservazione effettivamente live;
- età p95 della cache e successo del job ogni 20 minuti;
- copertura di heatmap solo con almeno 5 sessioni distinte per cella;
- errore delle previsioni rispetto alle osservazioni successive (MAE, bias, copertura);
- MAE della baseline storica contro MAE della previsione weather-adjusted,
  separata per categoria, orizzonte e condizione meteo;
- errori client e Edge Function senza includere coordinate o token nei log.

Non aumentare il limite oltre 100 venue finché l'audit non dimostra copertura, accuratezza e costo sostenibili.

## 4. Privacy e sicurezza sociale

Prima della beta pubblica pubblicare una privacy policy raggiungibile dall'app e documentare:

- finalità, base giuridica, retention e contatto privacy per la geolocalizzazione;
- opt-in foreground, revoca immediata e cancellazione dei dati nei tempi dichiarati;
- moderazione di `user_reports`, blocchi utente e tempi di risposta;
- test delle policy RLS con due account reali: follow, chat, blocco e report.

## 5. Quality gate di build

Eseguire localmente prima di ogni build:

```sh
npx tsc --noEmit
npx expo lint
npm run test:backend
npx expo export --platform ios --output-dir /tmp/live-city-ios-export
```

Poi verificare il flusso su dispositivo fisico: consenso posizione, revoca, mappa con cluster, schermata Trasparenza dati, login magic link, follow reciproco, chat e blocco.

## 6. Rollout

1. Beta interna con provider BestTime disabilitato e telemetria opt-in.
2. Beta limitata a Milano con BestTime sulle venue prioritarie.
3. Monitoraggio giornaliero di dati, privacy e costi.
4. Estensione controllata solo dopo metriche stabili per almeno una settimana.
