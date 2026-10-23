# Contribuire a LIVE CITY

## Workflow Git

1. Aggiornare `main` e creare un branch breve: `feature/...`, `fix/...` o
   `docs/...`.
2. Tenere ogni commit focalizzato e descriverlo con un verbo all’imperativo.
3. Non lavorare direttamente su `main` quando la modifica richiede review.
4. Aprire una pull request spiegando comportamento, fonti dati, test e impatto
   privacy.
5. Eseguire `npm run check` prima del push.

Non includere mai `.env`, token, dump del database, coordinate individuali,
cartelle native generate (`ios/`, `android/`) o output sotto `tmp/`.

## Convenzioni del codice

- TypeScript strict; evitare `any` salvo confini esterni validati.
- Componenti e tipi in `PascalCase`, funzioni e variabili in `camelCase`,
  costanti globali in `SCREAMING_SNAKE_CASE`.
- Le route restano sottili; logica e dataset riutilizzabili vanno in
  `src/features` o `src/lib`.
- Ogni chiamata remota deve gestire timeout/errore senza mostrare overlay
  tecnici all’utente.
- Un valore crowd deve portare con sé fonte, timestamp, freshness, confidence e
  stato (`fresh`, `stale`, `fallback`, `unavailable`).
- Non usare categoria, colore o dimensione del marker per inventare crowdness.

## Database e Edge Functions

- Creare una nuova migrazione per ogni modifica; non riscrivere migrazioni già
  applicate.
- Applicare RLS a ogni tabella leggibile dal client.
- Usare la service-role solo nelle Edge Functions e mai nel bundle Expo.
- Job non pubblici devono verificare il relativo secret prima di elaborare.
- Loggare identificatori tecnici e metriche aggregate, non coordinate precise o
  token.

## Privacy e provenienza

Le modifiche a telemetria e geolocalizzazione devono preservare opt-in,
quantizzazione locale, soglia k-anonima e retention documentata. Demo,
previsioni, mobilità programmata e partecipanti dichiarati non sono foot
traffic live e devono essere etichettati distintamente nell’API e nella UI.

## Checklist pull request

- [ ] `npm run check` è verde.
- [ ] Nessun segreto o artefatto locale è incluso.
- [ ] Migrazioni e nuove variabili sono documentate.
- [ ] Stati vuoti, errori e dati scaduti sono gestiti.
- [ ] La provenienza dei dati è visibile e corretta.
- [ ] L’impatto privacy è stato valutato.
