-- =====================================================================
-- ZGŁOSZENIA NIEOBECNOŚCI: KILKA ZMIAN / GODZIN W TYM SAMYM DNIU
--
-- Wcześniej drugie zgłoszenie na ten sam dzień było blokowane zawsze. Teraz blokowane jest tylko,
-- gdy godziny naprawdę się nakładają:
--   * zgłoszenie na cały dzień nakłada się z każdym innym w tym dniu,
--   * zgłoszenia na zmianę / godziny - tylko gdy ich godziny się pokrywają
--     (np. zmiana I 06:30–14:30 i zmiana II 14:30–22:30 można zgłosić osobno).
-- Akceptacja kolejnego zgłoszenia w dniu, który ma już nieobecność z godzinami, łączy godziny
-- w harmonogramie (np. 06:30–14:30 + 14:30–22:30 = 06:30–22:30); gdy między nimi jest przerwa,
-- dzień staje się nieobecnością na cały dzień.
--
-- Wymaga wcześniejszego 27_zgloszenia_nieobecnosci.sql i 28_nieobecnosci_godziny.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

-- "HH:MM" -> minuty od północy
create or replace function public.app_hm(p text)
returns integer
language sql
immutable
as $$
  select split_part(p, ':', 1)::int * 60 + split_part(p, ':', 2)::int
$$;

-- Minuty -> "HH:MM"
create or replace function public.app_hm_text(p integer)
returns text
language sql
immutable
as $$
  select lpad(((p % 1440 + 1440) % 1440 / 60)::text, 2, '0') || ':' || lpad(((p % 1440 + 1440) % 1440 % 60)::text, 2, '0')
$$;

-- Czy dwa przedziały godzin się nakładają (z przejściem przez północ); brak godzin = cały dzień
create or replace function public.app_hours_overlap(f1 text, t1 text, f2 text, t2 text)
returns boolean
language plpgsql
immutable
as $$
declare
  s1 int; e1 int; s2 int; e2 int; k int;
begin
  if f1 is null or t1 is null or f2 is null or t2 is null then
    return true;
  end if;
  s1 := public.app_hm(f1); e1 := public.app_hm(t1); if e1 <= s1 then e1 := e1 + 1440; end if;
  s2 := public.app_hm(f2); e2 := public.app_hm(t2); if e2 <= s2 then e2 := e2 + 1440; end if;
  foreach k in array array[-1440, 0, 1440] loop
    if s1 < e2 + k and s2 + k < e1 then
      return true;
    end if;
  end loop;
  return false;
end $$;

-- Przy dodaniu: kontrola nakładania z uwzględnieniem godzin
create or replace function public.app_trg_absence_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Europe/Warsaw')::date;
begin
  select e.department_id into new.department_id from public.employees e where e.id = new.employee_id;
  new.status := 'pending';
  new.created_at := now();
  new.decided_by := null;
  new.decided_at := null;
  new.decision_note := null;
  new.description := nullif(btrim(coalesce(new.description, '')), '');

  if new.date_from < v_today - 14 then
    raise exception 'Nieobecność można zgłosić najwyżej 14 dni wstecz.';
  end if;
  if new.reason = 'urlop_na_zadanie' and new.date_from < v_today then
    raise exception 'Urlop na żądanie można zgłosić najpóźniej w dniu nieobecności.';
  end if;
  if exists (
    select 1 from public."Closed_Periods" c
    where c.is_locked
      and c.year_month between to_char(new.date_from, 'YYYY-MM') and to_char(new.date_to, 'YYYY-MM')
  ) then
    raise exception 'Miesiąc w podanym okresie jest zablokowany.';
  end if;
  if exists (
    select 1 from public.absence_requests a
    where a.employee_id = new.employee_id
      and a.status in ('pending', 'approved')
      and a.date_from <= new.date_to and a.date_to >= new.date_from
      and public.app_hours_overlap(a.time_from, a.time_to, new.time_from, new.time_to)
  ) then
    raise exception 'Masz już zgłoszenie obejmujące te godziny w części tych dni.';
  end if;
  return new;
end $$;

-- Akceptacja: dzień po dniu, z łączeniem godzin, gdy dzień ma już nieobecność z godzinami
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
    select * into cur from public.schedule_days where employee_id = r.employee_id and day = v_day;
    v_from := r.time_from;
    v_to := r.time_to;
    v_note := v_label;

    if found and cur.kind = 'absence' then
      -- dzień ma już nieobecność: połącz godziny i powody
      if cur.note is not null and cur.note <> v_label then
        v_note := left(cur.note || ', ' || v_label, 80);
      end if;
      if cur.time_from is null or v_from is null then
        v_from := null; v_to := null;                 -- któraś obejmuje cały dzień
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
    end if;

    insert into public.schedule_days (employee_id, day, kind, note, time_from, time_to)
    values (r.employee_id, v_day, 'absence', v_note, v_from, v_to)
    on conflict (employee_id, day) do update
      set kind = 'absence', note = excluded.note, time_from = excluded.time_from, time_to = excluded.time_to;
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';
