-- =====================================================================
-- ODBICIA Z BRAMY: moduł "Odbicia z bramy" (js/gate.js) - wejścia i wyjścia pracowników
-- wgrywane z pliku Excel z systemu kontroli dostępu (raport "Rejestr zdarzeń").
--
--  * Uprawnienia (moduł Użytkownicy):
--      allow_gate_view - podgląd odbić,
--      allow_gate_edit - wgrywanie pliku, poprawianie i kasowanie odbić (daje też podgląd).
--    Administratorzy dostają oba od razu.
--  * Godziny z bramy (kolumny Wejście / Wyjście) widzi w oknie raportu każdy, kto ma dostęp
--    do Listy raportów (allow_reports, allow_time_reporting albo allow_report_approve).
--  * gate_entries - jedno odbicie = wejście i wyjście jednej osoby (jedno z nich może brakować).
--    Wpis z brakiem wejścia / wyjścia, bardzo długim pobytem albo nierozpoznaną osobą
--    jest oznaczony do weryfikacji (issues), dopóki ktoś go nie sprawdzi (verified).
--  * gate_people - który numer osoby z bramy (np. [422]) to który pracownik z Bazy pracowników;
--    zapamiętane przypisanie rozpoznaje osobę w kolejnych plikach.
--  * event_key (numer osoby + czas wejścia, a bez wejścia - czas wyjścia) chroni przed
--    zdublowaniem odbić przy ponownym wgraniu tego samego pliku.
--
-- Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

-- 1. Uprawnienia
alter table public.users add column if not exists allow_gate_view boolean not null default false;
alter table public.users add column if not exists allow_gate_edit boolean not null default false;
-- osobne uprawnienie do godzin w raportach z wcześniejszej wersji tego pliku nie jest już używane
alter table public.users drop column if exists allow_gate_reports;

update public.users u
   set allow_gate_view = true, allow_gate_edit = true
  from public.role r
 where r.id = u.role_id and lower(btrim(r.role)) = 'administrator';

-- 2. Osoby z bramy przypisane do pracowników
create table if not exists public.gate_people (
  gate_person_id integer primary key,
  gate_name      text not null,
  employee_id    bigint references public.employees (id) on delete set null,
  updated_at     timestamptz not null default now()
);

-- 3. Odbicia
create table if not exists public.gate_entries (
  id             bigserial primary key,
  event_key      text not null unique,
  gate_person_id integer,
  gate_name      text not null,                       -- imię i nazwisko z pliku
  employee_id    bigint references public.employees (id) on delete set null,
  first_name     text,
  last_name      text,
  firm           text,                                -- grupa z bramy: MDB, FLOWLINE, DEPO...
  work_date      date not null,                       -- dzień zmiany (III zmiana: dzień jej rozpoczęcia)
  shift          text,                                -- Zmiana I / Zmiana II / Zmiana III
  entry_at       timestamp,                           -- czas lokalny z bramy
  exit_at        timestamp,
  hours          numeric(5, 2),
  issues         text[] not null default '{}',        -- brak_wyjscia, brak_wejscia, dlugi_pobyt, nierozpoznany
  verified       boolean not null default false,
  source_file    text,
  imported_by    bigint,
  imported_at    timestamptz not null default now(),
  edited_by      bigint,
  edited_at      timestamptz,
  constraint gate_entries_time_check check (entry_at is not null or exit_at is not null)
);

create index if not exists gate_entries_work_date_idx on public.gate_entries (work_date);
create index if not exists gate_entries_person_idx on public.gate_entries (gate_person_id, entry_at);

-- 4. Dostęp
alter table public.gate_people enable row level security;
alter table public.gate_entries enable row level security;

-- odczyt: moduł odbić oraz okno raportu (oznaczenie "Brak dopasowania")
drop policy if exists gate_people_select on public.gate_people;
create policy gate_people_select on public.gate_people
  for select to authenticated
  using ((select public.app_perm('allow_gate_view')) or (select public.app_perm('allow_gate_edit'))
         or (select public.app_perm('allow_reports')) or (select public.app_perm('allow_time_reporting'))
         or (select public.app_perm('allow_report_approve')));

drop policy if exists gate_people_write on public.gate_people;
create policy gate_people_write on public.gate_people
  for all to authenticated
  using ((select public.app_perm('allow_gate_edit')))
  with check ((select public.app_perm('allow_gate_edit')));

-- odczyt: moduł odbić oraz godziny z bramy w oknie raportu (każdy z dostępem do Listy raportów)
drop policy if exists gate_entries_select on public.gate_entries;
create policy gate_entries_select on public.gate_entries
  for select to authenticated
  using ((select public.app_perm('allow_gate_view')) or (select public.app_perm('allow_gate_edit'))
         or (select public.app_perm('allow_reports')) or (select public.app_perm('allow_time_reporting'))
         or (select public.app_perm('allow_report_approve')));

drop policy if exists gate_entries_insert on public.gate_entries;
create policy gate_entries_insert on public.gate_entries
  for insert to authenticated
  with check ((select public.app_perm('allow_gate_edit')));

drop policy if exists gate_entries_update on public.gate_entries;
create policy gate_entries_update on public.gate_entries
  for update to authenticated
  using ((select public.app_perm('allow_gate_edit')))
  with check ((select public.app_perm('allow_gate_edit')));

drop policy if exists gate_entries_delete on public.gate_entries;
create policy gate_entries_delete on public.gate_entries
  for delete to authenticated
  using ((select public.app_perm('allow_gate_edit')));

grant select, insert, update, delete on public.gate_people, public.gate_entries to authenticated;
grant usage, select on sequence public.gate_entries_id_seq to authenticated;

commit;

notify pgrst, 'reload schema';
