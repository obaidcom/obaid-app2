-- عبيد للصيانة | استقبال إثبات الدفع من تطبيقات البنك
-- يضع ملفات PDF والصور خارج قاعدة البيانات داخل Supabase Storage.
-- المسار: payment-receipts/<user_id>/<invoice_id>/<timestamp>.<ext>

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-receipts',
  'payment-receipts',
  true,
  104857600,
  array['application/pdf','image/jpeg','image/png','image/webp']
)
on conflict (id) do update
set public = true,
    file_size_limit = 104857600,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "payment_receipts_insert_own" on storage.objects;

create policy "payment_receipts_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'payment-receipts'
  and (storage.foldername(name))[1] = (select private.my_user_id())::text
);

drop policy if exists "payment_receipts_update_own" on storage.objects;

create policy "payment_receipts_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'payment-receipts'
  and (storage.foldername(name))[1] = (select private.my_user_id())::text
)
with check (
  bucket_id = 'payment-receipts'
  and (storage.foldername(name))[1] = (select private.my_user_id())::text
);
