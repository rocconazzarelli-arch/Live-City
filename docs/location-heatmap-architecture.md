# LIVE CITY — geolocalizzazione, heatmap e capacità

## Stato del dato mostrato

La mappa deve distinguere sempre tre casi:

- **live**: BestTime fresco oppure telemetria LIVE CITY aggregata da almeno 5 sessioni anonime;
- **stima**: profilo temporale, evento o dato provider diventato stale con peso ridotto;
- **non disponibile**: nessun segnale utilizzabile.

La superficie di calore usa celle di circa 300–400 metri ottenute dai Crowd Score dei luoghi. Su Apple Maps `react-native-maps` non abilita l'overlay `Heatmap`; per questo il client usa due cerchi traslucidi concentrici per cella. È un rendering nativo, funziona nel simulatore iOS e non richiede Google Maps.

## Flusso end-to-end

```text
posizione foreground (opt-in)
        │  max 1 invio / 5 min o spostamento significativo
        ▼
location-ingest
        │  validazione UUID, coordinate, accuratezza e area Milano
        ▼
location_observations (grezzo, 24 ore)
        │
        ├──► place_presences (visita candidata/confermata, 7 giorni)
        │
        ▼
crowd_snapshots (finestra aggregata di 15 minuti, ricalcolata ogni 20)
        │  soglia privacy: almeno 5 sessioni distinte
        ├──► crowd_baselines / crowd_place_profiles
        ▼
crowd-engine-refresh
        │  BestTime + telemetria + eventi + profilo temporale
        ▼
crowd_estimates
        │
        ▼
places-read → marker e superficie di calore
```

Il refresh coordinato viene eseguito ogni 20 minuti. L'app rilegge luoghi ed eventi con la stessa frequenza mentre resta aperta.

## Politica BestTime

BestTime è una sorgente complementare, non un prerequisito per il funzionamento della mappa:

- massimo **100 venue prioritarie** nel ciclo provider;
- refresh BestTime al massimo **una volta per ora**; il dato viene riusato dalla pipeline e dall'app nei successivi refresh da 20 minuti;
- una venue è mostrata come live solo se BestTime restituisce un segnale fresco e disponibile oppure se la telemetria LIVE CITY supera la soglia privacy;
- se il provider è senza quota, lento o indisponibile, la pipeline continua con telemetria, eventi e modello temporale, etichettando il risultato come stima;
- prima di aumentare la copertura si esegue un audit di match e disponibilità live: la capacità tecnica del provider non equivale a copertura garantita per ogni luogo.

## Consenso e privacy

- Nessuna richiesta di posizione all'avvio.
- Il pulsante mirino spiega lo scopo prima del prompt di sistema.
- Solo autorizzazione **When In Use**; nessuna raccolta in background in V1.
- L'identificatore è un UUID casuale creato per la sessione e non è legato a nome, email o account.
- Il client non invia punti fuori dall'area di Milano e ignora rilevazioni con accuratezza peggiore di 250 metri; il server usa una soglia più severa per confermare la presenza presso un luogo.
- Le osservazioni grezze scadono dopo 24 ore, le presenze dopo 7 giorni.
- La UI non espone mai coordinate o sessioni individuali: un segnale diventa live solo con almeno 5 sessioni distinte.

Prima della distribuzione pubblica servono una privacy policy consultabile dall'app, registro dei trattamenti, base giuridica documentata e processo per revoca/cancellazione. La pseudonimizzazione riduce il rischio ma non rende la posizione un dato anonimo alla fonte.

## Capacità e crescita

Con il limite client di un invio ogni 5 minuti, 10.000 utenti foreground contemporanei producono al massimo teorico circa 2.000 osservazioni al minuto. Il caso reale è inferiore per opt-in, app in foreground, accuratezza e geofence.

La V1 usa indici su tempo, sessione e luogo. Le soglie operative consigliate sono:

- fino a circa 1 milione di osservazioni al giorno: tabella corrente indicizzata e retention oraria;
- oltre questa soglia: partizionamento giornaliero di `location_observations`, ingestione a batch e coda asincrona;
- calcolo heatmap: leggere solo snapshot aggregati, mai la tabella grezza;
- API pubblica: rate limit per installazione/IP, payload massimo e protezione anti-replay;
- monitoraggio: p95 ingest sotto 5 secondi, ritardo snapshot sotto 25 minuti, successo pipeline sopra 99%, numero di celle sotto soglia privacy.

Il matching attuale cerca i luoghi vicini. A catalogo molto più grande va sostituito con PostGIS (`geography` + indice GiST e `ST_DWithin`) così il costo non cresce linearmente con tutti i luoghi.

## Affidabilità delle predizioni

Una previsione non diventa affidabile perché viene aggiornata spesso. Per misurarla occorre salvare previsione e valore osservato, poi calcolare per categoria e fascia oraria MAE, bias e copertura. Le regole di rilascio consigliate:

- non mostrare confidence alta senza un segnale live fresco;
- usare telemetria solo sopra la soglia privacy;
- ridurre automaticamente il peso del provider con l'età;
- mantenere il fallback temporale esplicitamente etichettato come stima;
- ricalibrare i profili solo dopo almeno 12 finestre distribuite su 3 giorni.

## Fonti catalogo

Il catalogo iniziale Foursquare viene esteso in modo additivo fino a 300 luoghi reali con OpenStreetMap. I record mantengono `catalog_source` e `source_place_id`; la UI mostra l'attribuzione `© OpenStreetMap contributors`. Non vengono creati luoghi fittizi per raggiungere il target.
