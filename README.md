# LIVE CITY

LIVE CITY è un’app Expo/React Native per esplorare luoghi, eventi e livelli di
affollamento a Milano. Il progetto mantiene due strategie di crowd estimation
separate e confrontabili:

- **BestTime**: provider esterno, telemetria aggregata e storico osservato;
- **Mastercard transaction proxy**: conteggi aggregati e consentiti per locale,
  normalizzati sullo storico dello stesso esercente e mai presentati come
  conteggio di persone (vedi `docs/mastercard-transaction-crowd.md`);
- **Hybrid**: telemetria LIVE CITY, mobilità programmata, eventi e storico,
  senza dipendere da BestTime.

La provenienza del dato è parte del prodotto: una stima o un segnale di
mobilità non vengono mai presentati come presenza live verificata.

## Stack

- Expo SDK 57, React Native 0.86 e Expo Router;
- TypeScript in modalità strict;
- `react-native-maps` per mappa, marker e superfici di calore;
- Supabase Postgres, RLS ed Edge Functions;
- Deno per i test del Crowd Engine.

## Struttura del repository

```text
src/app/                 route e schermate Expo Router
src/components/          componenti condivisi e navigazione
src/features/            codice specifico di una funzionalità
src/lib/                 client e integrazioni condivise
supabase/functions/      Edge Functions, una directory per endpoint/job
supabase/migrations/     schema SQL versionato e policy RLS
tests/                   test deterministici del Crowd Engine
docs/                    architettura, privacy e runbook operativi
assets/                  icone e splash screen versionati
```

Le responsabilità principali sono documentate in
[`docs/architecture.md`](docs/architecture.md). Le regole di collaborazione
sono in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Configurazione locale

Expo SDK 57 richiede Node.js 22.13 o successivo. Clonare il repository in un
percorso **senza spazi**: alcuni script nativi Xcode/CocoaPods non gestiscono
correttamente directory come `SECRET PROJECT/live-city code`.

```bash
git clone https://github.com/rocconazzarelli-arch/live-city.git live-city
cd live-city
npm ci
cp .env.example .env
```

Configurare in `.env` soltanto valori pubblici destinati al client:

```dotenv
EXPO_PUBLIC_FSQ_API_KEY=...
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
EXPO_PUBLIC_ENABLE_DEMO_HEATMAP=false
```

Qualunque variabile `EXPO_PUBLIC_*` viene inclusa nel bundle. Chiavi private
BestTime, service-role Supabase e segreti dei job devono restare nei secret
Supabase, mai nel client o nel repository.

## Avvio

Per una verifica rapida con Expo Go:

```bash
npx expo start --go --lan
```

Per funzionalità native e test su dispositivo usare una development build:

```bash
npm run ios
npm run android
```

La heatmap dimostrativa è disattivata per default e non può essere inclusa in
una build di produzione. Per abilitarla localmente impostare
`EXPO_PUBLIC_ENABLE_DEMO_HEATMAP=true`; l’interfaccia la etichetta sempre come
**SIMULAZIONE — dati non reali**.

## Controlli prima di una pull request

```bash
npm run check
```

Il comando esegue TypeScript, ESLint e i test Deno del Crowd Engine. Per una
verifica aggiuntiva del bundle:

```bash
npx expo export --platform ios --output-dir /tmp/live-city-ios-export
```

## Backend e dati

Le migrazioni vanno applicate nell’ordine del timestamp e non devono essere
modificate dopo la pubblicazione. Il deploy è descritto nel
[`runbook di rilascio`](docs/production-rollout.md).

Documentazione di riferimento:

- [`Crowd Engine V1`](docs/crowd-engine-v1.md)
- [`Strategia Hybrid`](docs/hybrid-crowd-strategy.md)
- [`Architettura heatmap e geolocalizzazione`](docs/location-heatmap-architecture.md)
- [`Readiness private beta`](docs/private-beta.md)

## Stato dei dati

- **Live verificato**: osservazione provider esplicitamente live oppure cella
  telemetrica k-anonima e fresca.
- **Previsione**: storico, eventi o proxy di mobilità, sempre identificati come
  tali.
- **Non disponibile**: nessun valore numerico inventato; i marker restano
  neutri.
- **Demo**: dataset locale separato, abilitabile solo in sviluppo.

## Licenza

Vedere [`LICENSE`](LICENSE).
