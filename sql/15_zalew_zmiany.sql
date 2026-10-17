-- =====================================================================
-- ZALEW: podział zalewów na zmiany
--   Zmiana I   06:40 - 14:30
--   Zmiana II  14:30 - 22:30
--   Zmiana III 22:30 - 06:40 (przez północ; należy do dnia, w którym się zaczęła)
--
-- Dodaje kolumnę zmiana i uzupełnia ją w dotychczasowych zalewach według
-- godziny wpisu (created_at, czas polski).
--
-- Wymaga wcześniejszego 14_zalew_zalewy.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

alter table public.zalewy add column if not exists zmiana text;

alter table public.zalewy drop constraint if exists zalewy_zmiana_check;
alter table public.zalewy add constraint zalewy_zmiana_check
  check (zmiana in ('Zmiana I', 'Zmiana II', 'Zmiana III'));

-- dotychczasowe wpisy: zmiana według godziny wpisu
update public.zalewy
   set zmiana = case
     when (created_at at time zone 'Europe/Warsaw')::time >= time '06:40'
      and (created_at at time zone 'Europe/Warsaw')::time <  time '14:30' then 'Zmiana I'
     when (created_at at time zone 'Europe/Warsaw')::time >= time '14:30'
      and (created_at at time zone 'Europe/Warsaw')::time <  time '22:30' then 'Zmiana II'
     else 'Zmiana III'
   end
 where zmiana is null;

drop index if exists public.zalewy_linia_data_idx;
create index if not exists zalewy_linia_data_zmiana_idx on public.zalewy (linia, data_zalewu, zmiana);

commit;

notify pgrst, 'reload schema';
