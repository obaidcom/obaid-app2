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
  (select private.my_role())='admin'
  or auth_uid=(select auth.uid())
)
with check (
  (select private.my_role())='admin'
  or (
    auth_uid=(select auth.uid())
    and role=(
      select u.role from public.users u
      where u.auth_uid=(select auth.uid())
      limit 1
    )
  )
);