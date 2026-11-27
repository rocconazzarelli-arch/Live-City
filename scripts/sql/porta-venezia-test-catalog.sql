-- Seed the venues selected for the 2026-11-27 Porta Venezia test plus the
-- isolated 2026-11-29 CityLife morning marker.
-- This is provider-neutral: BestTime mappings are added separately after a
-- verified registration, so running this file never consumes provider credit.

insert into public.places (
  fsq_place_id,
  source_place_id,
  name,
  address,
  category,
  latitude,
  longitude,
  catalog_source,
  is_active
)
values
  ('test:porta-venezia:love', 'porta-venezia:love', 'Love', 'Via Melzo 5, Milano', 'nightlife', 45.4727643, 9.2097835, 'manual_test', true),
  ('test:porta-venezia:rainbow-cafe', 'porta-venezia:rainbow-cafe', 'Rainbow Café Milano', 'Via Alessandro Tadino 6, Milano', 'nightlife', 45.4773156, 9.2061738, 'manual_test', true),
  ('test:porta-venezia:red-cafe', 'porta-venezia:red-cafe', 'Red Café', 'Via Lecco 5, Milano', 'aperitivo', 45.4768569, 9.2040771, 'manual_test', true),
  ('test:porta-venezia:nura', 'porta-venezia:nura', 'Nura', 'Via Melzo 21, Milano', 'aperitivo', 45.4752995, 9.2076400, 'manual_test', true),
  ('test:porta-venezia:magutt', 'porta-venezia:magutt', 'Magutt', 'Via Lambro 11, Milano', 'aperitivo', 45.4743584, 9.2097377, 'manual_test', true),
  ('test:porta-venezia:brolo', 'porta-venezia:brolo', 'Brolo Milano - Orto con cucina', 'Via Melzo 19, Milano', 'food', 45.4751331, 9.2078117, 'manual_test', true),
  ('test:porta-venezia:malpighi-8', 'porta-venezia:malpighi-8', 'Malpighi 8', 'Via Marcello Malpighi 8, Milano', 'aperitivo', 45.4746967, 9.2077298, 'manual_test', true),
  ('test:porta-venezia:eppol', 'porta-venezia:eppol', 'Eppol', 'Via Marcello Malpighi 7, Milano', 'food', 45.4748734, 9.2076783, 'manual_test', true),
  ('test:porta-venezia:bar-picchio', 'porta-venezia:bar-picchio', 'Bar Picchio', 'Via Melzo 11, Milano', 'aperitivo', 45.4735746, 9.2092768, 'manual_test', true),
  ('test:porta-venezia:da-oscar', 'porta-venezia:da-oscar', 'Ristorante Da Oscar (Porta Venezia)', 'Via Lazzaro Palazzi 4, Milano', 'food', 45.4764399, 9.2059654, 'manual_test', true),
  ('test:citylife:california-bakery', 'citylife:california-bakery', 'California Bakery CityLife', 'Piazza Tre Torri, 20145 Milano MI', 'food', 45.4780925, 9.1570683, 'manual_test', true)
on conflict (fsq_place_id) do update
set name = excluded.name,
    address = excluded.address,
    category = excluded.category,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    catalog_source = excluded.catalog_source,
    is_active = true,
    updated_at = now();
