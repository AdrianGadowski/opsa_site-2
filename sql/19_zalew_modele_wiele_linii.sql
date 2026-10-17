-- =====================================================================
-- ZALEW: model może być przypisany do wielu linii
--
-- Co robi:
--   1. dodaje kolumnę lines (lista linii, np. {Lora,HWS}) i przenosi do niej
--      dotychczasową linię z kolumny line,
--   2. łączy duplikaty: ten sam numer modelu wpisany osobno na kilku liniach
--      staje się jednym modelem z kilkoma liniami. Zostaje wiersz z najmniejszym id
--      (jego waga), zalewy przepinane są na ten wiersz - ich zapisana waga się nie zmienia,
--   3. pilnuje, żeby model miał co najmniej jedną linię i tylko znane linie.
--
-- Kolumna line zostaje, ale strona już z niej nie korzysta.
--
-- Wymaga wcześniejszych 13 i 14. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

-- 1. Lista linii
alter table public.modele add column if not exists lines text[] not null default '{}';

update public.modele
   set lines = array[line]
 where line is not null and cardinality(lines) = 0;

-- 2. Połączenie duplikatów (ten sam numer modelu, bez względu na wielkość liter i spacje).
--    Wyzwalacz zalewów jest na chwilę wyłączony - inaczej przepięcie modelu nadpisałoby
--    zapisaną w zalewie wagę wagą zachowanego modelu.
alter table public.zalewy disable trigger app_zalewy_fill;

do $$
declare
  g record;
begin
  for g in
    select lower(btrim(nr_modelu)) as k, min(id) as keep_id
    from public.modele
    where nr_modelu is not null
    group by lower(btrim(nr_modelu))
    having count(*) > 1
  loop
    -- wszystkie linie duplikatów trafiają do zachowanego modelu
    update public.modele m
       set lines = (
         select array(
           select distinct l
           from public.modele d, unnest(d.lines) as l
           where lower(btrim(d.nr_modelu)) = g.k
           order by l
         )
       )
     where m.id = g.keep_id;

    -- zalewy wskazują teraz zachowany model (zapisana w nich waga zostaje)
    update public.zalewy
       set model_id = g.keep_id
     where model_id in (
       select id from public.modele
       where lower(btrim(nr_modelu)) = g.k and id <> g.keep_id
     );

    delete from public.modele
     where lower(btrim(nr_modelu)) = g.k and id <> g.keep_id;
  end loop;
end $$;

alter table public.zalewy enable trigger app_zalewy_fill;

-- 3. Poprawne linie
alter table public.modele drop constraint if exists modele_lines_check;
alter table public.modele add constraint modele_lines_check
  check (cardinality(lines) > 0 and lines <@ array['Lora', 'HWS', 'HWS-D', 'SMS']::text[]) not valid;
-- "not valid": model bez żadnej linii (jeśli taki był) zostaje, ale przy zapisie trzeba mu wybrać linię

create index if not exists modele_lines_idx on public.modele using gin (lines);

commit;

notify pgrst, 'reload schema';
