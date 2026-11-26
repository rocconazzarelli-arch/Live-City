# Supabase staging · avvio test LIVE CITY

Questo branch prepara un progetto Supabase nuovo e isolato. Il database nasce
vuoto, le migration ricreano lo schema e **tutti i cron che chiamano provider
esterni restano disattivati** finché non viene eseguito il runbook Porta Venezia.

## 1. Creazione e collegamento

Nel Dashboard Supabase creare un progetto, per esempio `live-city-staging`, in
una regione europea. Conservare la password del database in un password manager:
non va inserita nel repository né inviata in chat.

```bash
npx supabase login
npx supabase link --project-ref <NUOVO_PROJECT_REF>
npx supabase db push --remote --dry-run
npx supabase db push --remote
```

Il dry-run deve partire da `202609210000_foundation_schema.sql` e terminare con
`202611270021_staging_safe_defaults.sql`.

## 2. Secret server-side

Generare due valori casuali diversi (almeno 32 byte) e impostare i secret senza
scriverli in file versionati:

```bash
npx supabase secrets set \
  BESTTIME_PRIVATE_API_KEY='<BESTTIME_PRIVATE_API_KEY>' \
  CROWD_PIPELINE_SECRET='<VALORE_CASUALE>' \
  CROWD_ENGINE_REFRESH_SECRET='<ALTRO_VALORE_CASUALE>' \
  LOCATION_SESSION_HASH_SALT='<ALTRO_VALORE_CASUALE>'
```

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` sono forniti automaticamente alle
Edge Functions. La chiave BestTime deve avere almeno **95 crediti disponibili**
per il piano approvato (24 forecast + 71 live).

Nel SQL Editor salvare inoltre gli URL/segreti usati da pg_cron nel Vault:

```sql
select vault.create_secret(
  'https://<NUOVO_PROJECT_REF>.supabase.co',
  'supabase_project_url'
);
select vault.create_secret('<CROWD_PIPELINE_SECRET>', 'crowd_pipeline_secret');
```

## 3. Deploy delle funzioni necessarie

```bash
npx supabase functions deploy besttime-register
npx supabase functions deploy crowd-refresh
npx supabase functions deploy crowd-engine-refresh
npx supabase functions deploy weather-ingest
npx supabase functions deploy crowd-pipeline-refresh
npx supabase functions deploy places-read
npx supabase functions deploy events-read
npx supabase functions deploy events-create
npx supabase functions deploy location-ingest
npx supabase functions deploy area-heatmap-read
npx supabase functions deploy app-health
```

## 4. Configurazione client Expo

Copiare `.env.example` in `.env` e impostare soltanto valori pubblici:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://<NUOVO_PROJECT_REF>.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_KEY>
EXPO_PUBLIC_FSQ_API_KEY=<FOURSQUARE_KEY>
EXPO_PUBLIC_ENABLE_DEMO_HEATMAP=false
```

Le variabili `EXPO_PUBLIC_*` sono incluse nel bundle e non devono contenere
service-role key, password o chiavi provider private.

## 5. Preflight senza consumo BestTime

1. Aprire l'app e verificare che `Explore` raggiunga `app-health`.
2. Eseguire l'azione `validate-key` descritta in
   `docs/porta-venezia-test-setup.md`.
3. Verificare che non esistano cron provider attivi:

```sql
select jobname, schedule, active
from cron.job
where jobname like 'live-city-%'
order by jobname;
```

Non devono comparire i job `crowd-pipeline`, `hybrid-crowd`, `mobility-source`
o `test-friday/test-saturday` prima dell'attivazione controllata.

## 6. Attivazione del test

Seguire nell'ordine:

1. `scripts/sql/porta-venezia-catalog-and-mappings.sql`
2. registrazione BestTime in due batch 8 + 4
3. `scripts/sql/porta-venezia-venue-schedule.sql`
4. `scripts/sql/porta-venezia-test-cron.sql`, sostituendo la data del venerdì

La guardia SQL deve mostrare esattamente **12 venue, 71 live, 95 crediti
massimi**. Al termine, rimuovere i due cron di test come indicato nello script.

## Dati che restano da fornire

- project ref e publishable key del nuovo progetto Supabase;
- accesso Owner/Admin al progetto per migration, secrets e deploy;
- chiave privata BestTime valida con almeno 95 crediti (inserita direttamente
  nei Supabase secrets, non condivisa in chat);
- chiave pubblica Foursquare per popolare il catalogo;
- data e finestra oraria definitiva del test;
- conferma dei 12 locali e relativi match BestTime prima delle chiamate pagate.
