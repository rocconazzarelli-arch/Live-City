-- =============================================================================
-- LIVE CITY · Test Porta Venezia — orari di lettura per venue
-- =============================================================================
-- Imposta `venue_mappings.live_read_hours` (ore Europe/Rome, 0-23) per le 10
-- venue del test. Una lettura alle 19:30 appartiene all'ora 19, una alle 00:30
-- all'ora 0. Prerequisiti: migration 202611260020 applicata e le 10 righe già
-- inserite in venue_mappings (template in docs/porta-venezia-test-setup.md §4).
--
-- Sostituisci ogni <BESTTIME_VENUE_ID_...> con l'id restituito da BestTime al
-- momento della registrazione (New Forecast) del locale.
--
-- Budget massimo: 63 letture live + 10 registrazioni x 2 crediti = 83.
-- Non attivare il cron se uno dei controlli finali non restituisce l'atteso.
-- =============================================================================

-- Reset esplicito solo all'inizio di un nuovo test approvato. Durante il test,
-- crowd-refresh porta una venue a `suspended` al primo esito live non
-- disponibile e le chiamate successive la escludono automaticamente.
update public.venue_mappings
set live_availability_status = 'pending',
    live_suspended_at = null,
    live_suspension_reason = null,
    updated_at = now()
where besttime_venue_id in (
  '<BESTTIME_VENUE_ID_LOVE>', '<BESTTIME_VENUE_ID_RAINBOW_CAFE>',
  '<BESTTIME_VENUE_ID_RED_CAFE>', '<BESTTIME_VENUE_ID_BROLO>',
  '<BESTTIME_VENUE_ID_NURA>', '<BESTTIME_VENUE_ID_MAGUTT>',
  '<BESTTIME_VENUE_ID_MALPIGHI_8>', '<BESTTIME_VENUE_ID_EPPOL>',
  '<BESTTIME_VENUE_ID_BAR_PICCHIO>', '<BESTTIME_VENUE_ID_DA_OSCAR>'
);

update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_LOVE>';            -- 7 letture
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_RAINBOW_CAFE>';    -- 7
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_RED_CAFE>';        -- 7
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_NURA>';            -- 7
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_MAGUTT>';          -- 7
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_BROLO>';           -- 7
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_MALPIGHI_8>';      -- 6
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_EPPOL>';           -- 6
update public.venue_mappings set live_read_hours = '{19,20,21,22,23}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_BAR_PICCHIO>';     -- 5
update public.venue_mappings set live_read_hours = '{19,20,21,22}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_DA_OSCAR>';        -- 4
-- -----------------------------------------------------------------------------
-- GUARDIA DI BUDGET: la migration fail-closed converte NULL in array vuoto.
-- Durante la trial va comunque disattivata ogni venue fuori dal test.
update public.venue_mappings set live_read_hours = '{}'
where besttime_venue_id is not null
  and besttime_venue_id not in (
    '<BESTTIME_VENUE_ID_LOVE>', '<BESTTIME_VENUE_ID_RAINBOW_CAFE>',
    '<BESTTIME_VENUE_ID_RED_CAFE>', '<BESTTIME_VENUE_ID_BROLO>',
    '<BESTTIME_VENUE_ID_NURA>', '<BESTTIME_VENUE_ID_MAGUTT>',
    '<BESTTIME_VENUE_ID_MALPIGHI_8>', '<BESTTIME_VENUE_ID_EPPOL>',
    '<BESTTIME_VENUE_ID_BAR_PICCHIO>', '<BESTTIME_VENUE_ID_DA_OSCAR>'
  );
-- -----------------------------------------------------------------------------

-- CONTROLLI (da eseguire prima di attivare il cron)
-- 1) Nessuna venue senza orario (atteso: 0)
select count(*) as unscheduled_venues
from public.venue_mappings
where besttime_venue_id is not null and live_read_hours is null;

-- 2) Venue in programma e letture totali (atteso: 10 venue, 63 letture)
select count(*) as scheduled_venues,
       sum(cardinality(live_read_hours)) as planned_live_reads
from public.venue_mappings
where besttime_venue_id is not null
  and live_availability_status in ('pending', 'confirmed')
  and cardinality(live_read_hours) > 0;

-- 3) Letture per ora di Roma (atteso: 19-22 -> 10, 23 -> 9, 0 -> 8, 1 -> 6)
select hour, count(*) as venues
from public.venue_mappings, unnest(live_read_hours) as hour
where besttime_venue_id is not null
  and live_availability_status in ('pending', 'confirmed')
group by hour
order by case when hour < 12 then hour + 24 else hour end;

-- 4) Monitoraggio durante il test. Ogni riga `suspended` è esclusa dalle
-- letture future e quindi non consumerà altri crediti BestTime Live.
select besttime_name, besttime_venue_id, live_availability_status,
       live_suspended_at, live_suspension_reason
from public.venue_mappings
where besttime_venue_id is not null
order by live_availability_status, besttime_name;
