-- ============================================================
-- عبيد: Safe Auth + RLS migration
--
-- IMPORTANT:
-- 1) Before running: Authentication > Providers > Email > Confirm email = OFF
-- 2) Review this migration before applying it to production.
-- 3) This file intentionally does NOT create Auth users automatically.
--    The frontend must sign in/create/link Auth accounts and then store auth_uid.
-- 4) This migration does not drop data or remove pass_word.
-- ============================================================

-- 1) Link public.users to Supabase Auth
alter table public.users add column if not exists auth_uid uuid unique;
create index if not exists users_auth_uid_idx on public.users (auth_uid);

-- 2) Identity helper functions.
-- Use an empty search_path and fully-qualified names to reduce search_path hijacking risk.
create or replace function public.my_user_id()
returns bigint
language sql stable security definer
set search_path = ''
as $$
  select u.id
  from public.users u
  where u.auth_uid = auth.uid()
  limit 1;
$$;

create or replace function public.my_role()
returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce(u.role, 'user')
  from public.users u
  where u.auth_uid = auth.uid()
  limit 1;
$$;

create or replace function public.my_tech_id()
returns bigint
language sql stable security definer
set search_path = ''
as $$
  select t.id
  from public.technicians t
  join public.users u on u.id = t.user_ref_id
  where u.auth_uid = auth.uid()
  limit 1;
$$;

-- Helpers must not be callable anonymously.
revoke all on function public.my_user_id() from public, anon;
revoke all on function public.my_role() from public, anon;
revoke all on function public.my_tech_id() from public, anon;
grant execute on function public.my_user_id() to authenticated, service_role;
grant execute on function public.my_role() to authenticated, service_role;
grant execute on function public.my_tech_id() to authenticated, service_role;

-- 3) users isolation
alter table public.users enable row level security;

drop policy if exists "users_select_isolated" on public.users;
create policy "users_select_isolated" on public.users for select
using (
  public.my_role() = 'admin'
  or auth_uid = auth.uid()
  or id in (select o.user_id from public.orders o where o.tech_id = public.my_tech_id())
);

drop policy if exists "users_insert_public" on public.users;
create policy "users_insert_public" on public.users for insert
with check (auth.uid() is not null and (auth_uid is null or auth_uid = auth.uid()));

drop policy if exists "users_update_own" on public.users;
create policy "users_update_own" on public.users for update
using (public.my_role() = 'admin' or auth_uid = auth.uid())
with check (public.my_role() = 'admin' or auth_uid = auth.uid());

-- 4) orders isolation
alter table public.orders enable row level security;

drop policy if exists "orders_select_isolated" on public.orders;
create policy "orders_select_isolated" on public.orders for select
using (
  public.my_role() = 'admin'
  or user_id = public.my_user_id()
  or tech_id = public.my_tech_id()
  or (status = 'pending' and accepted_by_tech is null and public.my_tech_id() is not null)
);

drop policy if exists "orders_insert_own" on public.orders;
create policy "orders_insert_own" on public.orders for insert
with check (public.my_role() = 'admin' or user_id = public.my_user_id());

drop policy if exists "orders_update_isolated" on public.orders;
create policy "orders_update_isolated" on public.orders for update
using (
  public.my_role() = 'admin'
  or tech_id = public.my_tech_id()
  or (status = 'pending' and accepted_by_tech is null and public.my_tech_id() is not null)
)
with check (
  public.my_role() = 'admin'
  or tech_id = public.my_tech_id()
  or (status = 'pending' and accepted_by_tech is null and public.my_tech_id() is not null)
);

-- 5) invoices isolation
alter table public.invoices enable row level security;

drop policy if exists "invoices_select_isolated" on public.invoices;
create policy "invoices_select_isolated" on public.invoices for select
using (
  public.my_role() = 'admin'
  or customer_id = public.my_user_id()
  or tech_id = public.my_tech_id()
);

drop policy if exists "invoices_insert_isolated" on public.invoices;
create policy "invoices_insert_isolated" on public.invoices for insert
with check (public.my_role() = 'admin' or tech_id = public.my_tech_id());

drop policy if exists "invoices_update_isolated" on public.invoices;
create policy "invoices_update_isolated" on public.invoices for update
using (public.my_role() = 'admin' or tech_id = public.my_tech_id())
with check (public.my_role() = 'admin' or tech_id = public.my_tech_id());

-- 6) Technicians: do NOT expose sensitive columns through the base table.
-- Public technician browsing should use the existing technicians_public view.
-- Keep base-table SELECT restricted to admin/self. Do not use USING(true).
alter table public.technicians enable row level security;

drop policy if exists "technicians_select_public" on public.technicians;
drop policy if exists "technicians_select_isolated" on public.technicians;
create policy "technicians_select_isolated" on public.technicians for select
using (public.my_role() = 'admin' or id = public.my_tech_id());

drop policy if exists "technicians_update_isolated" on public.technicians;
create policy "technicians_update_isolated" on public.technicians for update
using (public.my_role() = 'admin' or id = public.my_tech_id())
with check (public.my_role() = 'admin' or id = public.my_tech_id());

drop policy if exists "technicians_insert_admin" on public.technicians;
create policy "technicians_insert_admin" on public.technicians for insert
with check (public.my_role() = 'admin');

drop policy if exists "technicians_delete_admin" on public.technicians;
create policy "technicians_delete_admin" on public.technicians for delete
using (public.my_role() = 'admin');

-- 7) settings: public read, admin-only writes.
alter table public.settings enable row level security;

drop policy if exists "settings_select_public" on public.settings;
create policy "settings_select_public" on public.settings for select using (true);

drop policy if exists "settings_write_admin_only" on public.settings;
create policy "settings_write_admin_only" on public.settings for insert
with check (public.my_role() = 'admin');

drop policy if exists "settings_update_admin_only" on public.settings;
create policy "settings_update_admin_only" on public.settings for update
using (public.my_role() = 'admin')
with check (public.my_role() = 'admin');

drop policy if exists "settings_delete_admin_only" on public.settings;
create policy "settings_delete_admin_only" on public.settings for delete
using (public.my_role() = 'admin');

-- NOTE: This migration deliberately does not modify notifications,
-- push_subscriptions, complaints, ratings, discount_codes, or other tables.
-- Apply their dedicated hardening migration separately after validating auth.
