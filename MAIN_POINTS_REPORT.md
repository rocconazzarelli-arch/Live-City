# MAIN POINTS REPORT

Registro condiviso degli aggiornamenti più rilevanti di ogni sessione di lavoro.
Qui io e il co-founder annotiamo i punti chiave di ciò che portiamo avanti, così restiamo sempre allineati e abbiamo una fonte comune.

## Come si usa

- Aggiungi una **nuova voce in cima** al Registro (la più recente per prima).
- **Una voce per sessione** di lavoro. Tieni i punti sintetici e concreti.
- Compila i campi: data, autore, area/tema, cosa è stato fatto, decisioni, prossimi passi, link.
- Modifica tramite **PR** (consigliato, così resta tracciato e revisionabile) oppure commit diretto, come preferite.
- Non inserire **mai** segreti (API key, token, service-role, password) in questo file.

## Template (copia, incolla in cima al Registro e compila)

```
### AAAA-MM-GG — <Nome autore> — <Area / Tema>

**Fatto:**
- …

**Decisioni:**
- …

**Prossimi passi:**
- …

**Link:** <PR / issue / commit rilevanti>
```

---

## Registro

### 2026-11-20 — <autore> — Backport heatmap · Strategia BestTime · Readiness Supabase

**Fatto:**
- Backport della heatmap "focus-zone" di Giorgio su **Expo SDK 57** (senza l'upgrade a SDK 58): zone focus a isolinee, vista 3D area, indice di stazionarietà. `npm run check` verde (51 test), verificato sul simulatore. → **PR #17**.
- Approfondita la **strategia dati BestTime** a budget limitato: il costo non è "quante venue" ma "quanto live". Impostazione: app servita dai **forecast in cache** (quasi gratis), **live chirurgico** solo su top venue nei picchi, **pacchetto a prezzo fisso** (mai metered) scalato per zona.
- Definito l'avvio di un **test**: 10 venue a **Porta Venezia**, abbonamento **Basic** BestTime.
- Audit di **readiness Supabase** per archiviare i dati e produrre trend settimanali.

**Decisioni:**
- Il backport resta su SDK 57: **non** si passa a SDK 58.
- Fase di test in **area ristretta e densa** (Porta Venezia), non copertura ampia.
- BestTime = dato **relativo** (indice 0–100), non assoluto: va etichettato come "Stima/relativo".

**Prossimi passi:**
- **Gap trovato (da sistemare prima del test):** `crowd_signals` viene cancellato a ~25h, ma `crowd_historical_slots` aggrega su 90 giorni e sovrascrive → i trend settimanali non si costruiscono. Fix: **archivio osservazioni durevole** (ritenzione ≥120–180 gg) + **cache forecast etichettata** (`besttime_forecast_slots`).
- Prerequisito test: inserire le **10 `venue_mappings`** di Porta Venezia (`besttime_venue_id` ↔ place, `live_priority`).
- Decidere la monetizzazione (affiliazione prenotazioni/biglietti, partnership locali) per auto-finanziare l'espansione zona per zona.

**Link:** PR #17 (backport heatmap SDK 57)

<!-- Aggiungi qui sopra la prossima voce, in cima al Registro. -->
