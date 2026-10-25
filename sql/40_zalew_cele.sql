-- =====================================================================
-- ZALEW: liczby zadane (cele) na zmianę - kadzie, metal w kadziach, formy dobre
--
-- Tabela zalew_cele: cel dla linii, opcjonalnie tylko na wybrany dzień i/lub zmianę.
--   dzien  = null -> każdy dzień,   zmiana = null -> każda zmiana.
-- Strona bierze najbardziej szczegółowy wpis: dzień + zmiana, potem sam dzień, potem sama zmiana,
-- na końcu cel ogólny linii. Puste pole (np. formy = null) = brak celu, kafelek pokazuje samą liczbę.
--
-- Na razie cele ustawia się tylko tutaj (SQL Editor), np.:
--   insert into public.zalew_cele (linia, dzien, zmiana, kadzie, metal_kg)
--   values ('Lora', '2026-10-27', 'Zmiana II', 25, 25000);
--
-- Startowo: Lora i HWS - 30 kadzi i 30 000 kg (30 t) metalu na zmianę; SMS i HWS-D bez celów.
-- Odczyt: osoby zalogowane do Zalewu i użytkownicy systemu (pulpit). Zmiany - tylko w panelu Supabase.
--
-- Można uruchomić ponownie (startowe cele nie zostaną zdublowane ani nadpisane).
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

create table if not exists public.zalew_cele (
  id bigint generated always as identity primary key,
  linia text not null check (linia in ('Lora', 'HWS', 'HWS-D', 'SMS')),
  dzien date,                                     -- null = każdy dzień
  zmiana text check (zmiana in ('Zmiana I', 'Zmiana II', 'Zmiana III')),   -- null = każda zmiana
  kadzie integer check (kadzie >= 0),             -- liczba kadzi na zmianę
  metal_kg integer check (metal_kg >= 0),         -- metal wlany do kadzi na zmianę (kg)
  formy integer check (formy >= 0),               -- formy dobre na zmianę
  uwagi text,
  created_at timestamptz not null default now()
);

-- jeden wpis na linię, dzień i zmianę (puste traktowane jak wartość)
create unique index if not exists zalew_cele_jeden_idx
  on public.zalew_cele (linia, coalesce(dzien, date '1900-01-01'), coalesce(zmiana, ''));

-- startowe cele ogólne linii - tylko przed 41_zalew_cele_dzien_i_zmiana.sql
-- (po nim data i zmiana są obowiązkowe, a cele wpisuje się na każdy dzień i zmianę osobno)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'zalew_cele' and column_name = 'dzien' and is_nullable = 'YES'
  ) then
    insert into public.zalew_cele (linia, kadzie, metal_kg)
    select v.linia, 30, 30000
    from (values ('Lora'), ('HWS')) as v(linia)
    where not exists (
      select 1 from public.zalew_cele c where c.linia = v.linia and c.dzien is null and c.zmiana is null
    );
  end if;
end $$;

alter table public.zalew_cele enable row level security;

drop policy if exists zalew_cele_select on public.zalew_cele;
create policy zalew_cele_select on public.zalew_cele
  for select to authenticated
  using ((select public.app_zalew_id()) is not null or (select public.app_user_id()) is not null);
-- brak polityk insert / update / delete: cele zmienia się w panelu Supabase

commit;

notify pgrst, 'reload schema';
