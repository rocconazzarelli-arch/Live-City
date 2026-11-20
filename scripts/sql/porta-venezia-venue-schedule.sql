-- =============================================================================
-- LIVE CITY · Test Porta Venezia — orari di lettura per venue
-- =============================================================================
-- Imposta `venue_mappings.live_read_hours` (ore Europe/Rome, 0-23) per le 13
-- venue del test. Una lettura alle 19:30 appartiene all'ora 19, una alle 00:30
-- all'ora 0. Prerequisiti: migration 202611200019 applicata e le 13 righe già
-- inserite in venue_mappings (template in docs/porta-venezia-test-setup.md §4).
--
-- Sostituisci ogni <BESTTIME_VENUE_ID_...> con l'id restituito da BestTime al
-- momento della registrazione (New Forecast) del locale.
--
-- Budget del piano: 75 letture live + 13 registrazioni x 2 crediti = 101.
-- La trial ha ~100 crediti: togli almeno una lettura prima di partire.
-- =============================================================================

update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_LOVE>';            -- 7 letture
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_RAINBOW_CAFE>';    -- 7
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_RED_CAFE>';        -- 7
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_EPPOL_PIE>';       -- 7
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_NURA>';            -- 7
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_MAGUTT>';          -- 7
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_MALPIGHI_8>';      -- 6
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_EPPOL>';           -- 6
update public.venue_mappings set live_read_hours = '{19,20,21,22,23,0}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_EROICA_CAFFE>';    -- 6
update public.venue_mappings set live_read_hours = '{19,20,21,22,23}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_BAR_PICCHIO>';     -- 5
update public.venue_mappings set live_read_hours = '{19,20,21,22}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_DA_OSCAR>';        -- 4
update public.venue_mappings set live_read_hours = '{19,20,21,22}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_BOTTEGA_DEL_PANE>'; -- 4
update public.venue_mappings set live_read_hours = '{0,1}'
  where besttime_venue_id = '<BESTTIME_VENUE_ID_MEYDAN_ISTANBUL>'; -- 2

-- Riserva (solo se restano crediti): Dirty Fellas 22:30, 23:30, 00:30.
-- update public.venue_mappings set live_read_hours = '{22,23,0}'
--   where besttime_venue_id = '<BESTTIME_VENUE_ID_DIRTY_FELLAS>';  -- 3

-- -----------------------------------------------------------------------------
-- GUARDIA DI BUDGET: una venue con live_read_hours NULL viene letta ad OGNI
-- esecuzione. Durante la trial va disattivata ogni venue fuori dal test.
-- Decommenta se il controllo qui sotto trova righe NULL non volute:
-- update public.venue_mappings set live_read_hours = '{}'
--   where live_read_hours is null;
-- -----------------------------------------------------------------------------

-- CONTROLLI (da eseguire prima di attivare il cron)
-- 1) Nessuna venue senza orario (atteso: 0)
select count(*) as unscheduled_venues
from public.venue_mappings
where besttime_venue_id is not null and live_read_hours is null;

-- 2) Venue in programma e letture totali (atteso: 13 venue, 75 letture)
select count(*) as scheduled_venues,
       sum(cardinality(live_read_hours)) as planned_live_reads
from public.venue_mappings
where besttime_venue_id is not null and cardinality(live_read_hours) > 0;

-- 3) Letture per ora di Roma (atteso: 19-22 -> 12, 23 -> 10, 0 -> 10, 1 -> 7)
select hour, count(*) as venues
from public.venue_mappings, unnest(live_read_hours) as hour
where besttime_venue_id is not null
group by hour
order by case when hour < 12 then hour + 24 else hour end;
