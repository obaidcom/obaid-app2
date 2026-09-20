-- إدارة النواحي من لوحة الإدارة
create table if not exists public.service_subdistricts (
  id bigint generated always as identity primary key,
  governorate text not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by bigint references public.users(id) on delete set null,
  constraint service_subdistricts_governorate_name_key unique (governorate, name)
);

create index if not exists service_subdistricts_governorate_active_idx
  on public.service_subdistricts (governorate, is_active);

alter table public.service_subdistricts enable row level security;

drop policy if exists service_subdistricts_select_authenticated on public.service_subdistricts;
create policy service_subdistricts_select_authenticated
on public.service_subdistricts for select to authenticated using (true);

drop policy if exists service_subdistricts_insert_admin on public.service_subdistricts;
create policy service_subdistricts_insert_admin
on public.service_subdistricts for insert to authenticated
with check ((select u.role from public.users u where u.auth_uid = auth.uid()) = 'admin');

drop policy if exists service_subdistricts_update_admin on public.service_subdistricts;
create policy service_subdistricts_update_admin
on public.service_subdistricts for update to authenticated
using ((select u.role from public.users u where u.auth_uid = auth.uid()) = 'admin')
with check ((select u.role from public.users u where u.auth_uid = auth.uid()) = 'admin');

drop policy if exists service_subdistricts_delete_admin on public.service_subdistricts;
create policy service_subdistricts_delete_admin
on public.service_subdistricts for delete to authenticated
using ((select u.role from public.users u where u.auth_uid = auth.uid()) = 'admin');
