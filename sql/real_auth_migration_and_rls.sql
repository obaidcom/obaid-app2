-- ============================================================
-- عبيد | Final Supabase Auth + RLS migration
-- ============================================================
-- This migration was applied to production after explicit approval.
-- It does not delete application data or create Auth users.
-- Existing legacy users without auth_uid must sign in/register through
-- Supabase Auth before they can use the new RLS-protected API.
--
-- Recommended Auth setting for the current app:
-- Authentication > Providers > Email > Confirm email = OFF
-- if the app is intended to allow immediate email/password login.
-- ============================================================

begin;

alter table public.users add column if not exists auth_uid uuid;
create unique index if not exists users_auth_uid_uidx on public.users(auth_uid) where auth_uid is not null;
create index if not exists technicians_user_ref_id_idx on public.technicians(user_ref_id);
create index if not exists orders_user_id_idx on public.orders(user_id);
create index if not exists orders_tech_id_idx on public.orders(tech_id);
create index if not exists invoices_customer_id_idx on public.invoices(customer_id);
create index if not exists invoices_tech_id_idx on public.invoices(tech_id);

create schema if not exists private;

create or replace function private.my_user_id()
returns bigint language sql stable security definer set search_path=''
as $$ select u.id from public.users u where u.auth_uid=(select auth.uid()) limit 1 $$;

create or replace function private.my_role()
returns text language sql stable security definer set search_path=''
as $$ select coalesce(u.role,'user') from public.users u where u.auth_uid=(select auth.uid()) limit 1 $$;

create or replace function private.my_tech_id()
returns bigint language sql stable security definer set search_path=''
as $$ select t.id from public.technicians t join public.users u on u.id=t.user_ref_id where u.auth_uid=(select auth.uid()) and coalesce(u.role,'user')='technician' limit 1 $$;

revoke all on function private.my_user_id() from public,anon;
revoke all on function private.my_role() from public,anon;
revoke all on function private.my_tech_id() from public,anon;
grant usage on schema private to authenticated;
grant execute on function private.my_user_id() to authenticated;
grant execute on function private.my_role() to authenticated;
grant execute on function private.my_tech_id() to authenticated;

alter table public.users enable row level security;
drop policy if exists "allow all - temporary" on public.users;
drop policy if exists p_users on public.users;
drop policy if exists users_select_isolated on public.users;
drop policy if exists users_insert_self on public.users;
drop policy if exists users_update_own on public.users;
drop policy if exists users_delete_admin on public.users;
drop policy if exists users_insert_public on public.users;
create policy users_select_isolated on public.users for select to authenticated using ((select private.my_role())='admin' or auth_uid=(select auth.uid()) or id in (select o.user_id from public.orders o where o.tech_id=(select private.my_tech_id())));
create policy users_insert_self on public.users for insert to authenticated with check (auth_uid=(select auth.uid()) and coalesce(role,'user')='user');
create policy users_update_own on public.users for update to authenticated using ((select private.my_role())='admin' or auth_uid=(select auth.uid())) with check ((select private.my_role())='admin' or (auth_uid=(select auth.uid()) and coalesce(role,'user')='user'));
create policy users_delete_admin on public.users for delete to authenticated using ((select private.my_role())='admin');

alter table public.orders enable row level security;
drop policy if exists "allow all - temporary" on public.orders;
drop policy if exists p_orders on public.orders;
drop policy if exists orders_select_isolated on public.orders;
drop policy if exists orders_insert_own on public.orders;
drop policy if exists orders_update_isolated on public.orders;
drop policy if exists orders_update_admin_or_owner on public.orders;
drop policy if exists orders_delete_admin on public.orders;
create policy orders_select_isolated on public.orders for select to authenticated using ((select private.my_role())='admin' or user_id=(select private.my_user_id()) or tech_id=(select private.my_tech_id()) or (status='pending' and accepted_by_tech is null and (select private.my_tech_id()) is not null));
create policy orders_insert_own on public.orders for insert to authenticated with check ((select private.my_role())='admin' or user_id=(select private.my_user_id()));
create policy orders_update_isolated on public.orders for update to authenticated using ((select private.my_role())='admin' or user_id=(select private.my_user_id()) or tech_id=(select private.my_tech_id()) or (status='pending' and accepted_by_tech is null and (select private.my_tech_id()) is not null)) with check ((select private.my_role())='admin' or user_id=(select private.my_user_id()) or tech_id=(select private.my_tech_id()));
create policy orders_delete_admin on public.orders for delete to authenticated using ((select private.my_role())='admin');

create or replace function private.accept_order(p_order_id bigint)
returns public.orders language plpgsql security definer set search_path=''
as $$
declare v_tech_id bigint; v_order public.orders;
begin
 if (select auth.uid()) is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;
 v_tech_id := (select private.my_tech_id());
 if v_tech_id is null then raise exception 'الحساب الحالي ليس حساب فني صالحاً'; end if;
 update public.orders set accepted_by_tech=v_tech_id, tech_id=v_tech_id, status=case when status='pending' then 'accepted' else status end, tech_accepted_at=now()
 where id=p_order_id and status='pending' and accepted_by_tech is null and tech_id is null
 returning * into v_order;
 if not found then raise exception 'الطلب غير متاح أو تم قبوله من فني آخر'; end if;
 return v_order;
end; $$;
revoke all on function private.accept_order(bigint) from public,anon;
grant execute on function private.accept_order(bigint) to authenticated;

alter table public.technicians enable row level security;
drop policy if exists "allow all - temporary" on public.technicians;
drop policy if exists p_techs on public.technicians;
drop policy if exists technicians_select_public on public.technicians;
drop policy if exists technicians_select_isolated on public.technicians;
drop policy if exists technicians_select_authenticated on public.technicians;
drop policy if exists technicians_update_isolated on public.technicians;
drop policy if exists technicians_update_admin_only on public.technicians;
drop policy if exists technicians_insert_admin on public.technicians;
drop policy if exists technicians_delete_admin on public.technicians;
create policy technicians_select_isolated on public.technicians for select to authenticated using ((select private.my_role())='admin' or id=(select private.my_tech_id()));
create policy technicians_update_admin_only on public.technicians for update to authenticated using ((select private.my_role())='admin') with check ((select private.my_role())='admin');
create policy technicians_insert_admin on public.technicians for insert to authenticated with check ((select private.my_role())='admin');
create policy technicians_delete_admin on public.technicians for delete to authenticated using ((select private.my_role())='admin');

alter table public.invoices enable row level security;
drop policy if exists "allow all - temporary" on public.invoices;
drop policy if exists p_invoices on public.invoices;
drop policy if exists invoices_select_isolated on public.invoices;
drop policy if exists invoices_insert_isolated on public.invoices;
drop policy if exists invoices_insert_admin_or_own_tech on public.invoices;
drop policy if exists invoices_update_isolated on public.invoices;
drop policy if exists invoices_update_admin_only on public.invoices;
drop policy if exists invoices_delete_admin on public.invoices;
create policy invoices_select_isolated on public.invoices for select to authenticated using ((select private.my_role())='admin' or customer_id=(select private.my_user_id()) or tech_id=(select private.my_tech_id()));
create policy invoices_insert_admin_or_own_tech on public.invoices for insert to authenticated with check ((select private.my_role())='admin' or tech_id=(select private.my_tech_id()));
create policy invoices_update_admin_only on public.invoices for update to authenticated using ((select private.my_role())='admin') with check ((select private.my_role())='admin');
create policy invoices_delete_admin on public.invoices for delete to authenticated using ((select private.my_role())='admin');

alter table public.settings enable row level security;
drop policy if exists "allow all - temporary" on public.settings;
drop policy if exists p_settings on public.settings;
drop policy if exists settings_select_public on public.settings;
drop policy if exists settings_write_admin on public.settings;
drop policy if exists settings_update_admin on public.settings;
drop policy if exists settings_delete_admin on public.settings;
create policy settings_select_public on public.settings for select to anon,authenticated using (true);
create policy settings_write_admin on public.settings for insert to authenticated with check ((select private.my_role())='admin');
create policy settings_update_admin on public.settings for update to authenticated using ((select private.my_role())='admin') with check ((select private.my_role())='admin');
create policy settings_delete_admin on public.settings for delete to authenticated using ((select private.my_role())='admin');

revoke execute on function public.notify_push_on_notification() from anon,authenticated;

commit;
