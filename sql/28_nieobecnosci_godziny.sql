-- =====================================================================
-- ZGŁOSZENIA NIEOBECNOŚCI: ZMIANA ALBO GODZINY
--
-- Zgłoszenie może dotyczyć całego dnia (brak godzin) albo zmiany / godzin (time_from–time_to,
-- np. zmiana I 06:30–14:30 albo 10:30–14:30). Po akceptacji godziny trafiają do harmonogramu:
-- wpis "zgłoszona nieobecność" w schedule_days może teraz mieć godziny.
--
-- Wymaga wcześniejszego 26_harmonogram_dni.sql i 27_zgloszenia_nieobecnosci.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

alter table public.absence_requests add column if not exists time_from text;
alter table public.absence_requests add column if not exists time_to text;

alter table public.absence_requests drop constraint if exists absence_requests_times_chk;
alter table public.absence_requests add constraint absence_requests_times_chk check (
  (time_from is null and time_to is null)
  or (time_from ~ '^\d{2}:\d{2}$' and time_to ~ '^\d{2}:\d{2}$' and time_from <> time_to)
);

-- Harmonogram: godziny zostają przy pracy i przy zgłoszonej nieobecności (przy wolnym - nie)
create or replace function public.app_trg_schedule_days_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(public.app_user_id(), new.updated_by);
  if new.kind = 'off' then
    new.time_from := null;
    new.time_to := null;
  end if;
  if new.kind = 'absence' and (new.time_from is null or new.time_to is null) then
    new.time_from := null;
    new.time_to := null;
  end if;
  if new.kind <> 'absence' then
    new.note := null;
  end if;
  return new;
end $$;

-- Akceptacja wpisuje dni do harmonogramu razem z godzinami zgłoszenia
create or replace function public.app_absence_decide(p_id bigint, p_approve boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.absence_requests;
  v_label text;
begin
  select * into r from public.absence_requests where id = p_id for update;
  if not found then
    raise exception 'Nie znaleziono zgłoszenia.';
  end if;
  if not public.app_is_master_of(r.department_id) then
    raise exception 'Zgłoszenia z tego działu może rozpatrzyć tylko mistrz działu.';
  end if;
  if r.status <> 'pending' then
    raise exception 'To zgłoszenie zostało już rozpatrzone.';
  end if;

  update public.absence_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      decided_by = public.app_user_id(),
      decided_at = now(),
      decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id;

  if p_approve then
    v_label := case r.reason
      when 'urlop' then 'urlop'
      when 'urlop_na_zadanie' then 'urlop na żądanie'
      when 'l4' then 'L4'
      when 'opieka' then 'opieka'
      else coalesce(left(r.description, 60), 'inny')
    end;
    insert into public.schedule_days (employee_id, day, kind, note, time_from, time_to)
    select r.employee_id, d::date, 'absence', v_label, r.time_from, r.time_to
    from generate_series(r.date_from, r.date_to, interval '1 day') as d
    on conflict (employee_id, day) do update
      set kind = 'absence', note = excluded.note, time_from = excluded.time_from, time_to = excluded.time_to;
  end if;
end $$;

commit;

notify pgrst, 'reload schema';
