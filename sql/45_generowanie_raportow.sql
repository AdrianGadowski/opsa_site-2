-- =====================================================================
-- GENEROWANIE RAPORTÓW PDF: nowe uprawnienie modułu "Generowanie raportów" (js/report_gen.js).
-- Moduł tylko czyta dane (raporty, pracowników, zamknięte miesiące), więc inne zmiany nie są potrzebne.
-- Administratorzy dostają uprawnienie od razu; pozostałym nadaje się je w module Użytkownicy.
--
-- Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

alter table public.users add column if not exists allow_report_generate boolean not null default false;

update public.users u
   set allow_report_generate = true
  from public.role r
 where r.id = u.role_id and lower(btrim(r.role)) = 'administrator';

commit;

notify pgrst, 'reload schema';
