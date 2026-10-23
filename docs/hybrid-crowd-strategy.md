# LIVE CITY Hybrid — telemetria, mobilità, eventi e storico

## Scopo

`Hybrid` è una variante separata dell'app. Non sostituisce la Home basata sulla
pipeline BestTime e non legge né la cache né la chiave del provider. Nell'app è
disponibile come quarta scheda, così le due strategie possono essere confrontate
senza sovrascrivere i rispettivi risultati.

## Fonti e significato

- **Telemetria LIVE CITY**: dato live soltanto quando una cella di circa 400 metri
  contiene almeno 5 sessioni opt-in distinte nella finestra recente. È l'unico
  segnale Hybrid mostrato come presenza live verificata.
- **Mobilità programmata**: indice di pressione calcolato dalla quantità di
  servizio di trasporto pubblico prevista presso le fermate della cella. Usa i
  dataset ufficiali del Comune di Milano/AMAT per fermate e orari di superficie
  e metropolitana. È un proxy previsionale, non un conteggio di persone.
- **Eventi**: boost prudente e limitato derivato da eventi editoriali o creati
  dagli utenti e dal numero dichiarato di partecipanti. Rimane una previsione.
- **Storico**: media per luogo, giorno della settimana e ora costruita soltanto
  da telemetria LIVE CITY osservata. Richiede almeno 12 campioni su 3 giorni e
  non incorpora osservazioni BestTime.

## Flusso

```text
location-ingest -> crowd_area_snapshots ----------┐
                                                   │
Comune Milano/AMAT -> mobility-source-refresh ----┼-> hybrid-crowd-refresh
                                                   │       │
eventi + hybrid_historical_slots -----------------┘       v
                                              hybrid_crowd_estimates
                                                       │
                                      places-read?strategy=hybrid
```

Le stime Hybrid sono conservate in `hybrid_crowd_estimates`; la pipeline
BestTime continua a scrivere in `crowd_estimates`. Il refresh Hybrid avviene ai
minuti 7, 27 e 47, dopo la normale aggregazione delle celle. La fonte mobilità
viene sincronizzata ogni notte; i dataset ufficiali sono aggiornati con una
frequenza molto più bassa, quindi il refresh giornaliero serve soprattutto a
rilevare nuove versioni senza richiedere un Mac acceso.

## Rendering heatmap

- superficie calda giallo/rosso/viola: telemetria aggregata reale;
- superficie turchese: mobilità programmata;
- superficie blu: previsioni da eventi.

Ogni card mantiene la provenienza e non presenta mai mobilità o partecipanti
dichiarati come foot traffic live.

## Deploy

```bash
npx supabase db push
npx supabase functions deploy mobility-source-refresh hybrid-crowd-refresh places-read area-heatmap-read
```

Dopo il deploy eseguire una prima sincronizzazione mobilità e un primo refresh
Hybrid dal dashboard Supabase o con una richiesta autenticata service-role.

## Dataset ufficiali

- Fermate e orari ATM di superficie, Comune di Milano, CC BY 4.0.
- Fermate e orari ATM metropolitani, Comune di Milano, CC BY 4.0.

Il modello usa il numero di corse programmate per fascia oraria e normalizza
l'intensità per cella rispetto al 90° percentile della stessa fascia. Questa
misura descrive l'offerta di mobilità, non la domanda effettiva o il numero di
passeggeri.
