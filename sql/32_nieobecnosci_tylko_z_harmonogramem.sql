-- =====================================================================
-- NIEOBECNOŚCI TYLKO DLA OSÓB Z DOSTĘPEM DO HARMONOGRAMU
--
-- Zgłoszenia nieobecności widzi i rozpatruje mistrz działu (rola "Mistrz") albo administrator,
-- ale tylko jeśli ma uprawnienie "Harmonogram" (allow_schedule).
-- Pracownik w portalu widzi jako akceptujących tylko takich mistrzów.
--
-- Wymaga wcześniejszego 27_zgloszenia_nieobecnosci.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

create or replace function public.app_is_master_of(p_department bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_perm('allow_schedule') and (
    public.app_is_admin() or exists (
      select 1
      from public.users u
      join public.role r on r.id = u.role_id
      where u.auth_id = auth.uid()
        and lower(btrim(r.role)) = 'mistrz'
        and u.department_id is not null
        and u.department_id = p_department
    )
  )
$$;

create or replace function public.app_absence_approvers()
returns table (name text)
language sql
stable
security definer
set search_path = public
as $$
  select btrim(coalesce(u.name, '') || ' ' || coalesce(u.last_name, ''))
  from public.employees e
  join public.users u on u.department_id = e.department_id
  join public.role r on r.id = u.role_id
  where e.id = public.app_employee_id()
    and e.department_id is not null
    and lower(btrim(r.role)) = 'mistrz'
    and coalesce((to_jsonb(u) ->> 'allow_schedule')::boolean, false)
  order by 1
$$;

commit;

notify pgrst, 'reload schema';
