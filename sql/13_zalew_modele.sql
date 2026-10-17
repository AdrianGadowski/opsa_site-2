-- =====================================================================
-- ZALEW: tabela modele (zakładki Lora, HWS, HWS-D, SMS na stronie Zalewu)
--
-- Co robi:
--   1. dodaje kolumnę line - do której zakładki (linii) należy model,
--   2. kolumny last_change i name_user_change wypełnia sama baza przy każdym
--      dodaniu i zmianie: data i godzina oraz imię i nazwisko osoby z zalew_users,
--   3. dostęp: modele widzi, dodaje, zmienia i usuwa każda osoba zalogowana do Zalewu.
--
-- Wymaga wcześniejszego 09_zalew.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

-- 1. Linia (zakładka)
alter table public.modele add column if not exists line text;

alter table public.modele drop constraint if exists modele_line_check;
alter table public.modele add constraint modele_line_check
  check (line in ('Lora', 'HWS', 'HWS-D', 'SMS'));

create index if not exists modele_line_idx on public.modele (line);

-- 2. Kto jest zalogowany do Zalewu
create or replace function public.app_zalew_id()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select z.id::bigint from public.zalew_users z where z.auth_id = auth.uid() limit 1
$$;

-- Data i autor ostatniej zmiany - ustawia baza, nie strona
create or replace function public.app_trg_modele_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select nullif(btrim(coalesce(z.first_name, '') || ' ' || coalesce(z.last_name, '')), '')
    into v_name
  from public.zalew_users z
  where z.auth_id = auth.uid();

  new.last_change := to_char(now() at time zone 'Europe/Warsaw', 'DD.MM.YYYY HH24:MI');
  -- zmiana z panelu Supabase (bez zalogowanej osoby) zostawia dotychczasowego autora
  new.name_user_change := coalesce(v_name, new.name_user_change);
  return new;
end $$;

drop trigger if exists app_modele_stamp on public.modele;
create trigger app_modele_stamp
  before insert or update on public.modele
  for each row execute function public.app_trg_modele_stamp();

-- 3. Dostęp tylko dla osób zalogowanych do Zalewu
alter table public.modele enable row level security;

drop policy if exists modele_select on public.modele;
create policy modele_select on public.modele
  for select to authenticated
  using ((select public.app_zalew_id()) is not null);

drop policy if exists modele_insert on public.modele;
create policy modele_insert on public.modele
  for insert to authenticated
  with check ((select public.app_zalew_id()) is not null);

drop policy if exists modele_update on public.modele;
create policy modele_update on public.modele
  for update to authenticated
  using ((select public.app_zalew_id()) is not null)
  with check ((select public.app_zalew_id()) is not null);

drop policy if exists modele_delete on public.modele;
create policy modele_delete on public.modele
  for delete to authenticated
  using ((select public.app_zalew_id()) is not null);

commit;

notify pgrst, 'reload schema';
