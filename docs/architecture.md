# Architettura LIVE CITY

## Client

| Area | File principali | Responsabilità |
| --- | --- | --- |
| Mappa BestTime | `src/app/index.tsx` | Luoghi, filtri, marker, heatmap, eventi e opt-in posizione |
| Mappa Hybrid | `src/app/hybrid.tsx` | Riusa la mappa con strategia `hybrid` |
| Trasparenza | `src/app/explore.tsx` | Salute delle fonti e spiegazione privacy |
| Social | `src/app/social.tsx` | Sessione, follow reciproco, chat, blocchi e report |
| Client social | `src/lib/social-client.ts` | Autenticazione e chiamate Supabase social |
| Heatmap demo | `src/features/map/demo-heatmap.ts` | Dataset fittizio isolato e solo development |

`src/app/index.tsx` è ancora una schermata ampia. Le nuove funzionalità non
devono aumentarne ulteriormente le responsabilità: estrarre progressivamente
hook (`usePlaces`, `useAreaHeatmap`, `useLocationContribution`) e componenti
presentazionali senza cambiare il contratto degli endpoint.

## Backend

| Funzione | Tipo | Scopo |
| --- | --- | --- |
| `places-read` | API client | Catalogo e crowd con provenienza |
| `events-read`, `events-create` | API client | Lettura e creazione eventi |
| `location-ingest` | API client | Ingestione cella quantizzata opt-in |
| `area-heatmap-read` | API client | Celle aggregate k-anonime |
| `app-health` | API client | Freshness e stato delle pipeline |
| `crowd-pipeline-refresh` | job | Orchestrazione aggregati e crowd |
| `crowd-engine-refresh` | job | Refresh BestTime prioritizzato |
| `crowd-refresh` | job | Stime da aree/storico |
| `mobility-source-refresh` | job | Import mobilità programmata |
| `hybrid-crowd-refresh` | job | Stime senza BestTime |

Le funzioni client verificano JWT; i job usano segreti server-side. La
configurazione è versionata in `supabase/config.toml`.

## Flusso dei dati

```text
Foursquare -> places -------------------------------> places-read
BestTime -> crowd_observations -> crowd_estimates --┤
opt-in location -> area snapshots -> estimates -----┤-> app map
mobility + events + hybrid history -> hybrid estimates
```

Le osservazioni grezze non sono leggibili dal client. La mappa territoriale
espone soltanto aggregati che superano la soglia privacy configurata.

## Decisioni vincolanti

1. BestTime e Hybrid restano strategie separate.
2. Nessun fallback numerico viene presentato come dato live.
3. Le previsioni storiche richiedono almeno 12 osservazioni su 3 giorni.
4. La heatmap reale richiede almeno 5 sessioni distinte per cella.
5. La demo è compilata solo in sviluppo e richiede un flag esplicito.
