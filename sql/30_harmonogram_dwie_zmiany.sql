-- =====================================================================
-- HARMONOGRAM: DWIE ZMIANY W JEDNYM DNIU
--
-- schedule_days dostaje kolumnę slot (1 albo 2): w jednym dniu pracownik może mieć dwa wpisy,
-- np. zmianę I i zmianę II, albo zmianę i zgłoszoną nieobecność na drugiej zmianie.
-- Unikalność: (employee_id, day, slot) zamiast (employee_id, day).
--
-- Akceptacja zgłoszenia nieobecności (app_absence_decide) wpisuje nieobecność tak:
--   * na cały dzień  -> zastępuje wszystkie wpisy dnia,
--   * na godziny     -> łączy się z istniejącą nieobecnością z godzinami albo zastępuje zmianę,
--                       z którą się pokrywa; w innym razie trafia w wolne miejsce (slot 1 lub 2).
--
-- Wymaga wcześniejszych 26–29. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

alter table public.schedule_days add column if not exists slot smallint not null default 1;

alter table public.schedule_days drop constraint if exists schedule_days_slot_chk;
alter table public.schedule_days add constraint schedule_days_slot_chk check (slot in (1, 2));

alter table public.schedule_days drop constraint if exists schedule_days_employee_id_day_key;
alter table public.schedule_days drop constraint if exists schedule_days_employee_day_slot_key;
alter table public.schedule_days add constraint schedule_days_employee_day_slot_key unique (employee_id, day, slot);

create or replace function public.app_absence_decide(p_id bigint, p_approve boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.absence_requests;
  v_label text;
  v_day date;
  cur public.schedule_days;
  v_from text; v_to text; v_note text;
  v_slot smallint;
  s1 int; e1 int; s2 int; e2 int;
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

  if not p_approve then
    return;
  end if;

  v_label := case r.reason
    when 'urlop' then 'urlop'
    when 'urlop_na_zadanie' then 'urlop na żądanie'
    when 'l4' then 'L4'
    when 'opieka' then 'opieka'
    else coalesce(left(r.description, 60), 'inny')
  end;

  for v_day in select d::date from generate_series(r.date_from, r.date_to, interval '1 day') as d loop
    v_from := r.time_from;
    v_to := r.time_to;
    v_note := v_label;

    if v_from is null then
      -- cały dzień: zastępuje wszystkie wpisy dnia (powody wcześniejszych nieobecności zostają)
      select string_agg(distinct note, ', ') into v_note
      from (select note from public.schedule_days
            where employee_id = r.employee_id and day = v_day and kind = 'absence' and note is not null
            union all select v_label) x;
      delete from public.schedule_days where employee_id = r.employee_id and day = v_day;
      insert into public.schedule_days (employee_id, day, slot, kind, note)
      values (r.employee_id, v_day, 1, 'absence', left(v_note, 80));
      continue;
    end if;

    -- dzień ma już nieobecność (na cały dzień albo na godziny): połącz
    select * into cur from public.schedule_days
    where employee_id = r.employee_id and day = v_day and kind = 'absence'
    order by slot limit 1;
    if found then
      if cur.note is not null and cur.note <> v_label then
        v_note := left(cur.note || ', ' || v_label, 80);
      end if;
      if cur.time_from is null then
        v_from := null; v_to := null;
      else
        s1 := public.app_hm(cur.time_from); e1 := public.app_hm(cur.time_to); if e1 <= s1 then e1 := e1 + 1440; end if;
        s2 := public.app_hm(v_from);        e2 := public.app_hm(v_to);        if e2 <= s2 then e2 := e2 + 1440; end if;
        if s2 <= e1 and s1 <= e2 and greatest(e1, e2) - least(s1, s2) < 1440 then
          v_from := public.app_hm_text(least(s1, s2));
          v_to := public.app_hm_text(greatest(e1, e2));
        else
          v_from := null; v_to := null;               -- przerwa między godzinami: cały dzień
        end if;
      end if;
      if v_from is null then
        delete from public.schedule_days where employee_id = r.employee_id and day = v_day and id <> cur.id;
        update public.schedule_days set slot = 1, kind = 'absence', note = v_note, time_from = null, time_to = null where id = cur.id;
      else
        update public.schedule_days set note = v_note, time_from = v_from, time_to = v_to where id = cur.id;
      end if;
      continue;
    end if;

    -- zmiana pokrywająca się z godzinami nieobecności: zastąp ją nieobecnością
    select * into cur from public.schedule_days
    where employee_id = r.employee_id and day = v_day
      and kind = 'work' and public.app_hours_overlap(time_from, time_to, v_from, v_to)
    order by slot limit 1;
    if found then
      update public.schedule_days set kind = 'absence', note = v_note, time_from = v_from, time_to = v_to where id = cur.id;
      continue;
    end if;

    -- wolne miejsce w dniu (wpis "wolne" zostaje zastąpiony)
    delete from public.schedule_days where employee_id = r.employee_id and day = v_day and kind = 'off';
    select s into v_slot from unnest(array[1, 2]::smallint[]) s
    where not exists (select 1 from public.schedule_days where employee_id = r.employee_id and day = v_day and slot = s)
    order by s limit 1;
    if v_slot is null then
      v_slot := 2;                                      -- oba miejsca zajęte: zastąp drugie
      delete from public.schedule_days where employee_id = r.employee_id and day = v_day and slot = 2;
    end if;
    insert into public.schedule_days (employee_id, day, slot, kind, note, time_from, time_to)
    values (r.employee_id, v_day, v_slot, 'absence', v_note, v_from, v_to);
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';
