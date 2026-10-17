-- =====================================================================
-- MODUŁY I KONTA ZALEW W OPCJACH
--
-- 1. Tabela app_modules: włączanie i wyłączanie modułów (Opcje -> Moduły).
--    Stan czytają wszyscy (także ekran logowania - zakładki Pracownik / Zalew),
--    zmieniać może tylko osoba z uprawnieniem "Opcje".
-- 2. Zarządzanie kontami Zalew ze strony (Opcje -> Konta Zalew)
--    przez osobę z uprawnieniem "Opcje". Hasła nadal trafiają do Supabase Auth
--    (wyzwalacz z 09_zalew.sql) i nie zostają w tabeli.
--
-- Wymaga wcześniejszych 01_przygotowanie.sql i 09_zalew.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Moduły
-- ---------------------------------------------------------------------
create table if not exists public.app_modules (
  key text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- wszystkie moduły na start włączone (brak wiersza też oznacza "włączony")
insert into public.app_modules (key) values
  ('dashboard'), ('employee_list'), ('report_time'), ('schedule'), ('reports'),
  ('users'), ('updates'), ('logs'), ('employee_portal'), ('zalew')
on conflict (key) do nothing;

alter table public.app_modules enable row level security;

drop policy if exists app_modules_select on public.app_modules;
create policy app_modules_select on public.app_modules
  for select to anon, authenticated using (true);

drop policy if exists app_modules_insert on public.app_modules;
create policy app_modules_insert on public.app_modules
  for insert to authenticated
  with check ((select public.app_perm('allow_options')));

drop policy if exists app_modules_update on public.app_modules;
create policy app_modules_update on public.app_modules
  for update to authenticated
  using ((select public.app_perm('allow_options')))
  with check ((select public.app_perm('allow_options')));
-- bez usuwania: wyłącza się przełącznikiem, nie przez skasowanie wiersza

-- ---------------------------------------------------------------------
-- 2. Konta Zalew zarządzane ze strony
--    (osoba z kontem Zalew nadal widzi tylko swój wiersz - polityka z 09_zalew.sql)
-- ---------------------------------------------------------------------
drop policy if exists zalew_users_admin_select on public.zalew_users;
create policy zalew_users_admin_select on public.zalew_users
  for select to authenticated
  using ((select public.app_perm('allow_options')));

drop policy if exists zalew_users_admin_insert on public.zalew_users;
create policy zalew_users_admin_insert on public.zalew_users
  for insert to authenticated
  with check ((select public.app_perm('allow_options')));

drop policy if exists zalew_users_admin_update on public.zalew_users;
create policy zalew_users_admin_update on public.zalew_users
  for update to authenticated
  using ((select public.app_perm('allow_options')))
  with check ((select public.app_perm('allow_options')));

drop policy if exists zalew_users_admin_delete on public.zalew_users;
create policy zalew_users_admin_delete on public.zalew_users
  for delete to authenticated
  using ((select public.app_perm('allow_options')));

-- Powiązania z kontem logowania (auth_id) nie da się ustawić ze strony.
-- Ten wyzwalacz (z 01_przygotowanie.sql) działa przed wyzwalaczem kont Zalew
-- (kolejność alfabetyczna nazw), więc konto i tak zostaje założone przez bazę.
drop trigger if exists app_protect_auth_id on public.zalew_users;
create trigger app_protect_auth_id
  before insert or update on public.zalew_users
  for each row execute function public.app_trg_protect_auth_id();

commit;

notify pgrst, 'reload schema';
