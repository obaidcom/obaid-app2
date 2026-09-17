-- عبيد للصيانة | Auth user sync + technician barcode integrity
-- Applied to production on 2026-09-18.

begin;

create or replace function private.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users (name, email, phone, pass_word, role, auth_uid)
  values (
    coalesce(nullif(new.raw_user_meta_data->>'name',''), split_part(new.email,'@',1), 'مستخدم'),
    new.email,
    coalesce(new.raw_user_meta_data->>'phone',''),
    'AUTH_MANAGED_' || replace(new.id::text,'-',''),
    'user',
    new.id
  )
  on conflict (email) do update
    set auth_uid = excluded.auth_uid,
        name = coalesce(nullif(public.users.name,''), excluded.name),
        phone = coalesce(public.users.phone, excluded.phone);
  return new;
end;
$$;

revoke all on function private.handle_auth_user_created() from public, anon, authenticated;
grant execute on function private.handle_auth_user_created() to postgres, service_role;

drop trigger if exists trg_auth_user_sync on auth.users;
create trigger trg_auth_user_sync after insert on auth.users
for each row execute function private.handle_auth_user_created();

insert into public.users (name, email, phone, pass_word, role, auth_uid)
select
  coalesce(nullif(au.raw_user_meta_data->>'name',''), split_part(au.email,'@',1), 'مستخدم'),
  au.email,
  coalesce(au.raw_user_meta_data->>'phone',''),
  'AUTH_MANAGED_' || replace(au.id::text,'-',''),
  'user',
  au.id
from auth.users au
where au.email is not null
  and not exists (select 1 from public.users u where u.auth_uid=au.id or lower(u.email)=lower(au.email));

update public.users u
set auth_uid = au.id
from auth.users au
where u.auth_uid is null and lower(u.email)=lower(au.email);

alter table public.technicians add column if not exists barcode_hash text;

create or replace function public.set_technician_barcode_hash()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.barcode_image is null or btrim(new.barcode_image) = '' then
    new.barcode_hash := null;
  else
    new.barcode_hash := md5(new.barcode_image);
  end if;
  return new;
end;
$$;

revoke all on function public.set_technician_barcode_hash() from public, anon, authenticated;
grant execute on function public.set_technician_barcode_hash() to postgres, service_role;

drop trigger if exists trg_technician_barcode_hash on public.technicians;
create trigger trg_technician_barcode_hash
before insert or update of barcode_image on public.technicians
for each row execute function public.set_technician_barcode_hash();

update public.technicians
set barcode_hash = md5(barcode_image)
where barcode_image is not null and btrim(barcode_image) <> '';

create unique index if not exists technicians_barcode_hash_uidx
on public.technicians(barcode_hash) where barcode_hash is not null;

create or replace function private.accept_order(p_order_id bigint)
returns public.orders language plpgsql security definer set search_path=''
as $$
declare v_tech_id bigint; v_order public.orders;
begin
  if (select auth.uid()) is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;
  v_tech_id := (select private.my_tech_id());
  if v_tech_id is null then raise exception 'الحساب الحالي ليس حساب فني صالحاً'; end if;
  update public.orders
     set accepted_by_tech=v_tech_id,
         tech_id=v_tech_id,
         tech_name=(select t.name from public.technicians t where t.id=v_tech_id),
         tech_phone=(select t.phone from public.technicians t where t.id=v_tech_id),
         status='accepted',
         tech_accepted_at=now(),
         updated_at=now()
   where id=p_order_id and status='pending' and accepted_by_tech is null and tech_id is null
   returning * into v_order;
  if not found then raise exception 'الطلب غير متاح أو تم قبوله من فني آخر'; end if;
  return v_order;
end;
$$;

commit;
