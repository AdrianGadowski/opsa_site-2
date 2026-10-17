-- =====================================================================
-- ZALEW: kontrola i naprawa wagi w zalewach
--
-- 1. Pokazuje, czy na tabeli zalewy jest wyzwalacz, który przy zapisie
--    kopiuje numer i wagę modelu (powinien być: app_zalewy_fill).
-- 2. Uzupełnia wagę i numer modelu w zalewach, które ich nie mają.
--
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

-- 1. Wyzwalacze na tabeli zalewy (jeśli brak app_zalewy_fill - uruchom ponownie 14 i 16)
select tgname as wyzwalacz, tgenabled as stan
from pg_trigger
where tgrelid = 'public.zalewy'::regclass and not tgisinternal;

-- 2. Uzupełnienie brakującej wagi i numeru modelu z tabeli modele
update public.zalewy z
   set waga = m.weight,
       nr_modelu = coalesce(z.nr_modelu, m.nr_modelu)
  from public.modele m
 where z.model_id = m.id
   and z.waga is null
   and m.weight is not null;
