-- عبيد للصيانة | 2026-09-19 auth + completion + invoice fix
-- تم تطبيق هذا الإصلاح على Production project pullcihxwmcoxqmzldqi.
-- الهدف: منع فشل التسجيل بسبب pass_word، وإنهاء الطلب دون الاعتماد على
-- PostgREST schema cache، وإنشاء فاتورة الفني وربطها بالطلب بشكل ذري.

begin;

alter table public.users alter column pass_word drop not null;
alter table public.orders add column if not exists completed_at timestamptz;

create or replace function public.create_my_user_profile(
  p_name text, p_email text, p_phone text
) returns public.users
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v public.users;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
  select * into v from public.users
  where auth_uid=auth.uid() or lower(email)=lower(p_email)
  limit 1;
  if v.id is not null then
    update public.users
    set auth_uid=auth.uid(),
        name=coalesce(nullif(p_name,''),name),
        phone=coalesce(p_phone,phone)
    where id=v.id
    returning * into v;
    return v;
  end if;
  insert into public.users(name,email,phone,pass_word,auth_uid,role)
  values(p_name,p_email,coalesce(p_phone,''),'AUTH_MANAGED_' || replace(auth.uid()::text,'-',''),auth.uid(),'user')
  returning * into v;
  return v;
end $$;

revoke all on function public.create_my_user_profile(text,text,text) from public,anon;
grant execute on function public.create_my_user_profile(text,text,text) to authenticated;

create or replace function public.complete_tech_order(p_order_id bigint)
returns public.orders language plpgsql security definer set search_path=''
as $$
declare v_tech_id bigint; v_order public.orders;
begin
  if (select auth.uid()) is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;
  v_tech_id := (select private.my_tech_id());
  if v_tech_id is null then raise exception 'الحساب الحالي ليس حساب فني صالحاً'; end if;
  update public.orders
  set status='completed', completed_at=now(), updated_at=now()
  where id=p_order_id and tech_id=v_tech_id and accepted_by_tech=v_tech_id
    and status='in-progress'
  returning * into v_order;
  if not found then
    raise exception 'لا يمكن إنهاء الطلب: الطلب غير موجود أو غير مسند إليك أو ليس في حالة جاري المعالجة';
  end if;
  return v_order;
end $$;

revoke all on function public.complete_tech_order(bigint) from public,anon;
grant execute on function public.complete_tech_order(bigint) to authenticated;

create or replace function public.create_tech_invoice(
  p_order_id bigint,p_invoice_number text,p_customer_id bigint,p_customer_name text,
  p_customer_email text,p_customer_phone text,p_service text,p_service_date text,
  p_base_price numeric,p_tax numeric,p_total numeric,p_status text,p_payment_method text,
  p_notes text,p_payment_barcode_image text,p_sent_at timestamptz
) returns public.invoices language plpgsql security definer set search_path=''
as $$
declare v_tech_id bigint; v_order public.orders; v_invoice public.invoices;
begin
  if (select auth.uid()) is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;
  v_tech_id := (select private.my_tech_id());
  if v_tech_id is null then raise exception 'الحساب الحالي ليس حساب فني صالحاً'; end if;

  select * into v_order from public.orders
  where id=p_order_id and tech_id=v_tech_id and accepted_by_tech=v_tech_id for update;
  if not found then raise exception 'الطلب غير موجود أو لا يتبع للفني الحالي'; end if;
  if v_order.status not in ('completed','awaiting_payment') then
    raise exception 'يجب إنهاء الطلب قبل إنشاء الفاتورة';
  end if;

  if v_order.invoice_id is not null then
    select * into v_invoice from public.invoices where id=v_order.invoice_id;
    if found then return v_invoice; end if;
  end if;

  insert into public.invoices(
    order_id,invoice_number,customer_id,customer_name,customer_email,customer_phone,
    service,service_date,base_price,tax,total,status,payment_method,notes,tech_id,
    payment_barcode_image,sent_at
  ) values (
    p_order_id,p_invoice_number,p_customer_id,p_customer_name,p_customer_email,p_customer_phone,
    p_service,p_service_date,coalesce(p_base_price,0),coalesce(p_tax,0),coalesce(p_total,0),
    coalesce(p_status,'pending_payment'),coalesce(p_payment_method,'barcode'),coalesce(p_notes,''),
    v_tech_id,p_payment_barcode_image,coalesce(p_sent_at,now())
  ) returning * into v_invoice;

  update public.orders
  set status='awaiting_payment',invoice_id=v_invoice.id,
      invoice_number=v_invoice.invoice_number,invoice_amount=v_invoice.total,
      payment_method=coalesce(p_payment_method,'barcode'),updated_at=now()
  where id=p_order_id;

  return v_invoice;
end $$;

revoke all on function public.create_tech_invoice(bigint,text,bigint,text,text,text,text,text,numeric,numeric,numeric,text,text,text,text,timestamptz) from public,anon;
grant execute on function public.create_tech_invoice(bigint,text,bigint,text,text,text,text,text,numeric,numeric,numeric,text,text,text,text,timestamptz) to authenticated;

notify pgrst,'reload schema';
commit;
