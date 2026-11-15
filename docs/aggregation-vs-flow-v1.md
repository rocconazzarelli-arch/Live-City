# Aggregazioni e flussi di passaggio — V1

Una heatmap è una foto della densità: una piazza piena e una via piena danno
la stessa immagine. Questa funzione aggiunge il segnale che le distingue, la
**quota di persone ferme**, e lo porta fino alle zone focus della mappa.

È il primo passo dell'idea #4 del backlog: solo l'indice di stazionarietà.
Forma della zona, persistenza nel tempo e confronto con l'atteso arrivano con
il modello predittivo (idea #1).

## Come si calcola

`refresh_crowd_area_snapshots()` gira ogni 20 minuti. Per ogni cella di circa
400 m, oltre alle sessioni distinte, ora conta:

- **sessioni ferme**: l'ultima cella della sessione è questa e la sessione ci
  è rimasta, senza uscirne, per almeno 15 minuti;
- **sessioni in transito**: la sessione è stata vista in più di una cella
  nella finestra di 20 minuti e non è ferma in questa cella.

Chi ha una sola osservazione, o è arrivato da meno di 15 minuti senza cambiare
cella, non è classificato. La permanenza si misura sugli ultimi 40 minuti,
così chi è fermo da tempo viene riconosciuto anche con un solo invio nella
finestra.

`area-heatmap-read` aggiunge a ogni cella `stationaryShare`:
ferme / (ferme + in transito).

## Privacy

- I conteggi restano in `crowd_area_snapshots`, tabella non leggibile dal
  client. All'esterno esce solo la quota.
- La quota è pubblicata solo se le sessioni classificate sono almeno 5, ed è
  arrotondata a passi di 0,05. Sotto soglia il valore è `null`.
- Non viene ricostruito né salvato alcun percorso: per ogni sessione si usa
  solo "ferma" o "in transito" nella finestra corrente, poi si aggrega.
- Retention e consenso non cambiano: osservazioni grezze per 24 ore, solo con
  consenso `2026-10-private-beta-1`.

## Nell'app

`buildFocusZones` legge la quota attorno a ogni picco (media pesata sulla
densità entro 150 m) e assegna un tipo:

| Tipo | Quota di persone ferme | Etichetta |
| --- | --- | --- |
| `gathering` | 0,60 o più | Gente ferma |
| `mixed` | tra 0,35 e 0,60 | Fermi e di passaggio |
| `flow` | 0,35 o meno | Di passaggio |
| `unknown` | segnale assente | nessuna |

Sulla mappa il tag di una zona `flow` mostra "Di passaggio" al posto del tipo
di ritrovo; la scheda della vista 3D mostra tipo e quota. Senza segnale non
cambia nulla rispetto a prima: nessun valore viene inventato.

Le soglie 0,60 e 0,35 sono una prima ipotesi, da tarare sulla telemetria
reale. La distinzione tra "evento" (più del solito) e "zona vivace abituale"
non esiste ancora: richiede l'atteso dell'idea #1.

Il campo dimostrativo simula la quota (aperitivo e ristoranti quasi fermi, vie
dello shopping quasi tutte in transito), sempre e solo dietro
`EXPO_PUBLIC_ENABLE_DEMO_HEATMAP=true`.

## Rilascio

1. Applicare la migrazione `202611150014_cell_stationarity.sql`.
2. Solo dopo, pubblicare `area-heatmap-read`: la funzione legge le nuove
   colonne e fallisce se non esistono.
3. Il client è compatibile in entrambi i sensi: senza `stationaryShare` le
   zone restano di tipo `unknown`.

## Verifica

- `npm run test:focus-zones`: classificazione, soglia privacy, celle reali e
  campo demo.
- `scripts/sql/check-cell-stationarity.sql`: su un database di sviluppo
  inserisce sessioni sintetiche, esegue il refresh, confronta i conteggi e fa
  rollback di tutto.

## Limiti

- Serve volume: almeno 5 sessioni classificate per cella. All'inizio il
  segnale esiste solo nelle zone più frequentate.
- Le celle sono di circa 400 m e gli invii al massimo uno ogni 5 minuti: chi
  cammina dentro la stessa cella per 15 minuti risulta fermo.
- La telemetria è solo in foreground: chi tiene l'app aperta è più spesso
  fermo di chi cammina, quindi la quota tende a sovrastimare i fermi.
