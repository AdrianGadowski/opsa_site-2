-- =====================================================================
-- ZALEW: liczby zadane ustalane dla KAŻDEGO dnia i zmiany osobno (data, zmiana)
--
-- Po tym pliku każdy cel w tabeli zalew_cele ma konkretną datę i zmianę:
--   - usuwa cele ogólne (bez daty albo bez zmiany) z 40_zalew_cele.sql,
--   - data i zmiana stają się obowiązkowe,
--   - wypełnia cele dzień po dniu i zmiana po zmianie dla podanego okresu:
--     Lora i HWS - 30 kadzi i 30 000 kg (30 t) metalu na każdą zmianę; SMS i HWS-D bez celów.
-- Dzień / zmiana bez wpisu = brak liczby zadanej (kafelek pokazuje samą liczbę).
--
-- Okres ustaw w linii "od / do" niżej (domyślnie: od dziś do końca roku).
-- Istniejące cele w tym okresie zostają (nie są nadpisywane) - zmienione ręcznie wartości nie przepadną.
-- Wymaga 40_zalew_cele.sql. Można uruchomić ponownie, np. z kolejnym okresem.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

-- 1. tylko cele z datą i zmianą
delete from public.zalew_cele where dzien is null or zmiana is null;
alter table public.zalew_cele alter column dzien set not null;
alter table public.zalew_cele alter column zmiana set not null;

-- 2. cele dzień po dniu, zmiana po zmianie
insert into public.zalew_cele (dzien, zmiana, linia, kadzie, metal_kg)
select d::date, z.zmiana, l.linia, 30, 30000
from generate_series(
       current_date,                        -- od
       date_trunc('year', current_date)::date + interval '1 year - 1 day',   -- do (koniec roku)
       interval '1 day') as d
cross join (values ('Zmiana I'), ('Zmiana II'), ('Zmiana III')) as z(zmiana)
cross join (values ('Lora'), ('HWS')) as l(linia)
on conflict (linia, coalesce(dzien, date '1900-01-01'), coalesce(zmiana, '')) do nothing;

commit;

notify pgrst, 'reload schema';

-- Podgląd: kolejno data, zmiana, linia
select dzien as data, zmiana, linia, kadzie, metal_kg, formy
from public.zalew_cele
order by dzien,
         case zmiana when 'Zmiana I' then 1 when 'Zmiana II' then 2 else 3 end,
         linia;
