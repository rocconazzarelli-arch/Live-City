-- LIVE CITY: distribute the 100 BestTime Live slots fairly across the five
-- visible categories. The map can show 30 places per category, but only the
-- 100 highest-priority mapped venues are allowed to consume BestTime live
-- capacity in an hourly provider refresh.

begin;

with ranked_mappings as (
  select
    mappings.fsq_place_id,
    row_number() over (
      partition by places.category
      order by
        case estimates.activity_level
          when 'very_high' then 4
          when 'high' then 3
          when 'medium' then 2
          when 'low' then 1
          else 0
        end desc,
        coalesce(estimates.score, 0) desc,
        places.id asc
    ) as category_rank
  from public.venue_mappings mappings
  join public.places places on places.fsq_place_id = mappings.fsq_place_id
  left join public.crowd_estimates estimates on estimates.place_id = places.id
  where mappings.besttime_venue_id is not null
    and places.is_active = true
)
update public.venue_mappings mappings
set live_priority = case
  when ranked_mappings.category_rank <= 20 then 101 - ranked_mappings.category_rank
  else 0
end
from ranked_mappings
where mappings.fsq_place_id = ranked_mappings.fsq_place_id;

comment on column public.venue_mappings.live_priority is
  'Hourly BestTime Live priority. The top 20 mapped venues in each category are eligible first, for a hard total budget of 100.';

commit;
