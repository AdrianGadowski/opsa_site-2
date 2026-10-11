-- =====================================================================
-- LOGI: dziennik zdarzeń (strona "Logi")
--
-- Co robi:
--   1. dodaje do users kolumnę uprawnienia allow_logs,
--   2. tworzy tabelę app_logs,
--   3. tworzy funkcję app_log, przez którą strona zapisuje zdarzenia.
--
-- Bezpieczeństwo:
--   - wpis można dodać tylko przez funkcję app_log, a ta sama ustala, kto jest
--     zalogowany - nie da się zapisać zdarzenia "za kogoś",
--   - logi czyta tylko osoba z uprawnieniem "Logi",
--   - ze strony nie da się logów zmieniać ani usuwać.
--
-- Wymaga wcześniejszego 01_przygotowanie.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

-- 1. Uprawnienie do strony "Logi" (nadaje się je w module Użytkownicy)
alter table public.users
  add column if not exists allow_logs boolean not null default false;

-- Administratorzy dostają je od razu: ich kont nie widać w module Użytkownicy,
-- więc nie dałoby się im tego uprawnienia nadać ze strony.
update public.users u
   set allow_logs = true
  from public.role r
 where r.id = u.role_id and lower(btrim(r.role)) = 'administrator';

-- 2. Tabela zdarzeń
create table if not exists public.app_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_kind text not null check (actor_kind in ('user', 'employee')),
  actor_id bigint,
  actor_name text,
  action text not null,
  details text
);

create index if not exists app_logs_kind_time_idx on public.app_logs (actor_kind, created_at desc);

alter table public.app_logs enable row level security;

drop policy if exists app_logs_select on public.app_logs;
create policy app_logs_select on public.app_logs
  for select to authenticated
  using ((select public.app_perm('allow_logs')));
-- brak polityk insert / update / delete: ze strony nie da się pisać do tabeli bezpośrednio

-- 3. Zapis zdarzenia. Autor jest brany z sesji (auth.uid()), nie z parametrów.
create or replace function public.app_log(p_action text, p_details text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_kind text;
  v_id bigint;
  v_name text;
begin
  if v_uid is null or p_action is null or btrim(p_action) = '' then
    return;
  end if;

  select 'user', u.id, btrim(coalesce(u.name, '') || ' ' || coalesce(u.last_name, ''))
    into v_kind, v_id, v_name
  from public.users u
  where u.auth_id = v_uid;

  if v_id is null then
    select 'employee', e.id, btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, ''))
      into v_kind, v_id, v_name
    from public.employees e
    where e.auth_id = v_uid;
  end if;

  if v_id is null then
    return; -- konto bez profilu: nic nie zapisuj
  end if;

  insert into public.app_logs (actor_kind, actor_id, actor_name, action, details)
  values (v_kind, v_id, nullif(v_name, ''), left(btrim(p_action), 100), nullif(left(btrim(coalesce(p_details, '')), 1000), ''));
end $$;

grant execute on function public.app_log(text, text) to authenticated;
revoke execute on function public.app_log(text, text) from anon;

notify pgrst, 'reload schema';
