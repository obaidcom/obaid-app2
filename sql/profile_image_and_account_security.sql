-- عبيد | إصلاح صور الملف الشخصي + حماية تحديث الحساب
-- تم تطبيق هذه التغييرات فعلياً على Supabase Production.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars','avatars',true,2097152,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set
  public=true,
  file_size_limit=2097152,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif'];

drop policy if exists "avatars_public_read" on storage.objects;
drop policy if exists "avatars_insert_own" on storage.objects;
drop policy if exists "avatars_update_own" on storage.objects;
drop policy if exists "avatars_delete_own" on storage.objects;

create policy "avatars_public_read" on storage.objects
for select to public using (bucket_id='avatars');

create policy "avatars_insert_own" on storage.objects
for insert to authenticated
with check (
  bucket_id='avatars'
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

create policy "avatars_update_own" on storage.objects
for update to authenticated
using (
  bucket_id='avatars'
  and (storage.foldername(name))[1]=(select auth.uid())::text
)
with check (
  bucket_id='avatars'
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

create policy "avatars_delete_own" on storage.objects
for delete to authenticated
using (
  bucket_id='avatars'
  and (storage.foldername(name))[1]=(select auth.uid())::text
);

drop policy if exists "users_update_own" on public.users;
create policy "users_update_own" on public.users
for update to authenticated
using (
  private.my_role()='admin'
  or auth_uid=(select auth.uid())
)
with check (
  private.my_role()='admin'
  or (
    auth_uid=(select auth.uid())
    and role=private.my_role()
  )
);

-- Account verification badge (admin controlled)
alter table public.users
  add column if not exists is_verified boolean not null default false;

create index if not exists idx_users_is_verified on public.users(is_verified);

create or replace function private.my_user_is_verified()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(u.is_verified,false)
  from public.users u
  where u.auth_uid = (select auth.uid())
  limit 1
$function$;

revoke all on function private.my_user_is_verified() from public;
grant execute on function private.my_user_is_verified() to authenticated;

drop policy if exists "users_update_own" on public.users;
create policy "users_update_own" on public.users
for update to authenticated
using (
  private.my_role()='admin'
  or auth_uid=(select auth.uid())
)
with check (
  private.my_role()='admin'
  or (
    auth_uid=(select auth.uid())
    and role=private.my_role()
    and is_verified=private.my_user_is_verified()
  )
);
