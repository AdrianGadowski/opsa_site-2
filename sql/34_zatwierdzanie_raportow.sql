-- =====================================================================
-- ZATWIERDZANIE RAPORTÓW CZASU PRACY
--
-- Każdy raport (wiersze work_reports o tym samym number_report) ma status:
--   pending  - w oczekiwaniu na zatwierdzenie (nowy albo poprawiony i wysłany ponownie),
--   rejected - odesłany do poprawy (z powodem),
--   approved - zatwierdzony: nie da się go zmienić ani usunąć.
--
--  * Zatwierdza, odrzuca i cofa zatwierdzenie tylko osoba z uprawnieniem
--    "Zatwierdzanie raportów" (users.allow_report_approve) - raporty z całego zakładu.
--  * Raport w oczekiwaniu albo do poprawy edytuje jak dotąd autor (albo administrator).
--    Poprawiony raport autor wysyła ponownie (app_report_resubmit).
--  * Cofnięcie zatwierdzenia nie jest możliwe w zablokowanym miesiącu (najpierw odblokowanie w Opcjach).
--  * Miesiąca nie da się zablokować, dopóki ma niezatwierdzone raporty.
--  * Statusu nie da się zmienić bezpośrednio w tabeli - tylko funkcjami poniżej,
--    a każda zmiana trafia do Logów.
--  * Odesłanie do poprawy wysyła autorowi powiadomienie push z powodem (Edge Function absence-push).
--  * Raporty istniejące przed uruchomieniem tego pliku są od razu zatwierdzone.
--
-- Wymaga wcześniejszych: 02_zabezpieczenie.sql, 08_logi.sql, 24_raporty_dzial_mistrza.sql,
-- 31_powiadomienia_push.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- Po uruchomieniu wdróż ponownie funkcję absence-push (supabase/functions/absence-push/index.ts).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Uprawnienie "Zatwierdzanie raportów"
--    Administratorzy dostają je od razu (ich kont nie widać w module Użytkownicy).
-- ---------------------------------------------------------------------
alter table public.users
  add column if not exists allow_report_approve boolean not null default false;

update public.users u
   set allow_report_approve = true
  from public.role r
 where r.id = u.role_id and lower(btrim(r.role)) = 'administrator';

-- ---------------------------------------------------------------------
-- 2. Status raportu na każdym jego wierszu
--    Przy pierwszym uruchomieniu istniejące wiersze dostają "approved" (dodanie kolumny
--    z wartością domyślną nie uruchamia wyzwalaczy, więc blokada miesięcy nie przeszkadza);
--    potem domyślnym statusem nowych wierszy jest "pending".
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'work_reports' and column_name = 'approval_status'
  ) then
    alter table public.work_reports add column approval_status text not null default 'approved';
  end if;
end $$;

alter table public.work_reports alter column approval_status set default 'pending';

alter table public.work_reports
  add column if not exists approved_by bigint references public.users (id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists rejected_by bigint references public.users (id) on delete set null,
  add column if not exists rejected_at timestamptz,
  add column if not exists reject_reason text,
  add column if not exists submitted_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'work_reports_approval_status_check') then
    alter table public.work_reports
      add constraint work_reports_approval_status_check
      check (approval_status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

create index if not exists work_reports_approval_status_idx on public.work_reports (approval_status);
create index if not exists work_reports_number_report_idx on public.work_reports (number_report);

-- ---------------------------------------------------------------------
-- 3. Ochrona statusu i zatwierdzonych raportów
--    - nowy raport: "pending"; wiersz dopisany do istniejącego raportu dostaje jego status;
--    - do zatwierdzonego raportu nie da się dopisać, zmienić ani usunąć wiersza;
--    - pól statusu nie da się zmienić zwykłą edycją (tylko funkcjami z punktu 5,
--      które ustawiają na czas swojej transakcji znacznik app.report_approval).
-- ---------------------------------------------------------------------
create or replace function public.app_trg_report_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_by_function boolean := coalesce(current_setting('app.report_approval', true), '') = 'on';
  r public.work_reports;
begin
  if tg_op = 'INSERT' then
    select * into r
    from public.work_reports w
    where w.number_report = new.number_report
    limit 1;

    if found then
      if r.approval_status = 'approved' then
        raise exception 'Raport nr % jest zatwierdzony. Nie można do niego dopisywać osób - poproś osobę z uprawnieniem "Zatwierdzanie raportów" o cofnięcie zatwierdzenia.', new.number_report;
      end if;
      new.approval_status := r.approval_status;
      new.approved_by := null;
      new.approved_at := null;
      new.rejected_by := r.rejected_by;
      new.rejected_at := r.rejected_at;
      new.reject_reason := r.reject_reason;
      new.submitted_at := r.submitted_at;
    else
      new.approval_status := 'pending';
      new.approved_by := null;
      new.approved_at := null;
      new.rejected_by := null;
      new.rejected_at := null;
      new.reject_reason := null;
      new.submitted_at := now();
    end if;
    return new;
  end if;

  if v_by_function then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if old.approval_status = 'approved' then
    raise exception 'Raport nr % jest zatwierdzony. Zmiany są możliwe dopiero po cofnięciu zatwierdzenia.', old.number_report;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  new.approval_status := old.approval_status;
  new.approved_by := old.approved_by;
  new.approved_at := old.approved_at;
  new.rejected_by := old.rejected_by;
  new.rejected_at := old.rejected_at;
  new.reject_reason := old.reject_reason;
  new.submitted_at := old.submitted_at;
  return new;
end $$;

drop trigger if exists app_report_approval on public.work_reports;
create trigger app_report_approval
  before insert or update or delete on public.work_reports
  for each row execute function public.app_trg_report_approval();

-- ---------------------------------------------------------------------
-- 4. Niezatwierdzone raporty w miesiącu ("RRRR-MM") i blokada zamknięcia takiego miesiąca
-- ---------------------------------------------------------------------
create or replace function public.app_report_unapproved_in_month(p_key text)
returns table (pending int, rejected int)
language sql
stable
security definer
set search_path = public
as $$
  select
    (count(distinct w.number_report) filter (where w.approval_status = 'pending'))::int,
    (count(distinct w.number_report) filter (where w.approval_status = 'rejected'))::int
  from public.work_reports w
  where public.app_user_id() is not null
    and w.approval_status <> 'approved'
    and w.report_date like '%.' || substr(p_key, 6, 2) || '.' || substr(p_key, 1, 4);
$$;

grant execute on function public.app_report_unapproved_in_month(text) to authenticated;
revoke execute on function public.app_report_unapproved_in_month(text) from anon;

create or replace function public.app_trg_lock_needs_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending int;
  v_rejected int;
begin
  if not coalesce(new.is_locked, false) or (tg_op = 'UPDATE' and coalesce(old.is_locked, false)) then
    return new;
  end if;

  select
    count(distinct w.number_report) filter (where w.approval_status = 'pending'),
    count(distinct w.number_report) filter (where w.approval_status = 'rejected')
    into v_pending, v_rejected
  from public.work_reports w
  where w.approval_status <> 'approved'
    and w.report_date like '%.' || substr(new.year_month, 6, 2) || '.' || substr(new.year_month, 1, 4);

  if v_pending + v_rejected > 0 then
    raise exception 'Nie można zablokować miesiąca %: niezatwierdzone raporty - w oczekiwaniu na zatwierdzenie: %, do poprawy: %.',
      new.year_month, v_pending, v_rejected;
  end if;
  return new;
end $$;

drop trigger if exists app_lock_needs_approval on public."Closed_Periods";
create trigger app_lock_needs_approval
  before insert or update on public."Closed_Periods"
  for each row execute function public.app_trg_lock_needs_approval();

-- ---------------------------------------------------------------------
-- 5. Funkcje wywoływane ze strony
-- ---------------------------------------------------------------------

-- Opis raportu do logów: "Raport nr 12, 05.10.2026, Zmiana I, autor: Jan Kowalski"
create or replace function public.app_report_label(p_number bigint)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'Raport nr ' || w.number_report || ', ' || coalesce(w.report_date, '?') || ', ' || coalesce(w.shift, '-')
         || coalesce(', autor: ' || nullif(btrim(coalesce(u.name, '') || ' ' || coalesce(u.last_name, '')), ''), '')
  from public.work_reports w
  left join public.users u on u.id = w.add_first_name_id
  where w.number_report::bigint = p_number
  limit 1;
$$;

revoke execute on function public.app_report_label(bigint) from anon, authenticated;

-- Zatwierdzenie jednego albo kilku raportów (tylko w oczekiwaniu). Zwraca liczbę zatwierdzonych raportów.
create or replace function public.app_report_approve(p_numbers bigint[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_numbers bigint[];
  n bigint;
begin
  if not public.app_perm('allow_report_approve') then
    raise exception 'Brak uprawnienia "Zatwierdzanie raportów".';
  end if;

  select array_agg(distinct w.number_report::bigint) into v_numbers
  from public.work_reports w
  where w.number_report::bigint = any (coalesce(p_numbers, '{}'))
    and w.approval_status = 'pending';
  if v_numbers is null then
    return 0;
  end if;

  perform set_config('app.report_approval', 'on', true);
  update public.work_reports
     set approval_status = 'approved',
         approved_by = public.app_user_id(),
         approved_at = now()
   where number_report::bigint = any (v_numbers);
  perform set_config('app.report_approval', 'off', true);

  foreach n in array v_numbers loop
    perform public.app_log('Zatwierdzenie raportu', public.app_report_label(n));
  end loop;
  return coalesce(array_length(v_numbers, 1), 0);
end $$;

-- Odesłanie do poprawy (tylko w oczekiwaniu); powód jest opcjonalny. Autor dostaje push.
create or replace function public.app_report_reject(p_number bigint, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := nullif(btrim(left(coalesce(p_reason, ''), 500)), '');
  v_url text;
  v_secret text;
begin
  if not public.app_perm('allow_report_approve') then
    raise exception 'Brak uprawnienia "Zatwierdzanie raportów".';
  end if;
  if not exists (
    select 1 from public.work_reports
    where number_report::bigint = p_number and approval_status = 'pending'
  ) then
    raise exception 'Raport nr % nie czeka na zatwierdzenie (mógł zostać już zatwierdzony albo odesłany).', p_number;
  end if;

  perform set_config('app.report_approval', 'on', true);
  update public.work_reports
     set approval_status = 'rejected',
         rejected_by = public.app_user_id(),
         rejected_at = now(),
         reject_reason = v_reason,
         approved_by = null,
         approved_at = null
   where number_report::bigint = p_number;
  perform set_config('app.report_approval', 'off', true);

  perform public.app_log('Odesłanie raportu do poprawy',
    public.app_report_label(p_number) || coalesce('. Powód: ' || v_reason, ''));

  -- powiadomienie push do autora (błąd wysyłki nie cofa odrzucenia)
  select value into v_url from public.app_private_settings where key = 'push_function_url';
  select value into v_secret from public.app_private_settings where key = 'push_hook_secret';
  if v_url is not null and v_secret is not null and v_secret <> 'WKLEJ_TUTAJ_HASLO' then
    begin
      perform net.http_post(
        url := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
        body := jsonb_build_object('report_number', p_number, 'event', 'report_rejected')
      );
    exception when others then
      raise warning 'Powiadomienie push nie zostało wysłane: %', sqlerrm;
    end;
  end if;
end $$;

-- Cofnięcie zatwierdzenia: raport wraca do "w oczekiwaniu". Nie w zablokowanym miesiącu.
create or replace function public.app_report_unapprove(p_number bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date text;
begin
  if not public.app_perm('allow_report_approve') then
    raise exception 'Brak uprawnienia "Zatwierdzanie raportów".';
  end if;
  select report_date into v_date
  from public.work_reports
  where number_report::bigint = p_number and approval_status = 'approved'
  limit 1;
  if v_date is null then
    raise exception 'Raport nr % nie jest zatwierdzony.', p_number;
  end if;
  if exists (
    select 1 from public."Closed_Periods"
    where is_locked and year_month = substr(v_date, 7, 4) || '-' || substr(v_date, 4, 2)
  ) then
    raise exception 'Miesiąc % jest zablokowany. Aby cofnąć zatwierdzenie, najpierw odblokuj miesiąc w Opcjach.', substr(v_date, 4, 7);
  end if;

  perform set_config('app.report_approval', 'on', true);
  update public.work_reports
     set approval_status = 'pending',
         approved_by = null,
         approved_at = null
   where number_report::bigint = p_number;
  perform set_config('app.report_approval', 'off', true);

  perform public.app_log('Cofnięcie zatwierdzenia raportu', public.app_report_label(p_number));
end $$;

-- Ponowne wysłanie poprawionego raportu: autor (albo administrator) z dostępem do raportów.
-- Powód poprzedniego odrzucenia zostaje, żeby zatwierdzający widział, co miało być poprawione.
create or replace function public.app_report_resubmit(p_number bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author bigint;
begin
  select add_first_name_id into v_author
  from public.work_reports
  where number_report::bigint = p_number and approval_status = 'rejected'
  limit 1;
  if not found then
    raise exception 'Raport nr % nie jest odesłany do poprawy.', p_number;
  end if;
  if not ((public.app_perm('allow_reports') or public.app_perm('allow_time_reporting'))
          and (v_author = public.app_user_id() or public.app_is_admin())) then
    raise exception 'Raport może wysłać ponownie tylko jego autor albo administrator.';
  end if;

  perform set_config('app.report_approval', 'on', true);
  update public.work_reports
     set approval_status = 'pending',
         submitted_at = now()
   where number_report::bigint = p_number;
  perform set_config('app.report_approval', 'off', true);

  perform public.app_log('Ponowne wysłanie raportu do zatwierdzenia', public.app_report_label(p_number));
end $$;

-- Liczniki w menu: zatwierdzający widzi wszystkie raporty, pozostali - swoje
create or replace function public.app_report_counts()
returns table (pending int, rejected int, my_pending int, my_rejected int)
language sql
stable
security definer
set search_path = public
as $$
  select
    case when public.app_perm('allow_report_approve')
      then (count(distinct w.number_report) filter (where w.approval_status = 'pending'))::int else 0 end,
    case when public.app_perm('allow_report_approve')
      then (count(distinct w.number_report) filter (where w.approval_status = 'rejected'))::int else 0 end,
    (count(distinct w.number_report) filter (where w.approval_status = 'pending' and w.add_first_name_id = public.app_user_id()))::int,
    (count(distinct w.number_report) filter (where w.approval_status = 'rejected' and w.add_first_name_id = public.app_user_id()))::int
  from public.work_reports w
  where w.approval_status <> 'approved'
    and public.app_user_id() is not null;
$$;

grant execute on function public.app_report_approve(bigint[]) to authenticated;
grant execute on function public.app_report_reject(bigint, text) to authenticated;
grant execute on function public.app_report_unapprove(bigint) to authenticated;
grant execute on function public.app_report_resubmit(bigint) to authenticated;
grant execute on function public.app_report_counts() to authenticated;
revoke execute on function public.app_report_approve(bigint[]) from anon;
revoke execute on function public.app_report_reject(bigint, text) from anon;
revoke execute on function public.app_report_unapprove(bigint) from anon;
revoke execute on function public.app_report_resubmit(bigint) from anon;
revoke execute on function public.app_report_counts() from anon;

commit;

notify pgrst, 'reload schema';
