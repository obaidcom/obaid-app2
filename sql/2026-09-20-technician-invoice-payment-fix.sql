-- عبيد للصيانة | 2026-09-20 technician invoice payment verification fix
-- إصلاح قبول إيصال الدفع من قائمة الفني بحيث تصبح الفاتورة "مدفوعة"
-- عند الفني والعميل مع تحديث الطلب المرتبط إلى "مكتمل".

begin;

create or replace function public.tech_verify_invoice_payment(
  p_invoice_id bigint,
  p_status text
)
returns public.invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tech_id bigint;
  v_invoice public.invoices;
begin
  if (select auth.uid()) is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  v_tech_id := (select private.my_tech_id());
  if v_tech_id is null then
    raise exception 'الحساب الحالي ليس حساب فني صالحاً';
  end if;

  if p_status not in ('verified','rejected') then
    raise exception 'حالة التحقق غير صالحة';
  end if;

  select *
    into v_invoice
  from public.invoices
  where id = p_invoice_id
    and tech_id = v_tech_id
  for update;

  if not found then
    raise exception 'الفاتورة غير موجودة أو لا تتبع للفني الحالي';
  end if;

  if v_invoice.receipt_image is null or btrim(v_invoice.receipt_image) = '' then
    raise exception 'لا يوجد إيصال دفع مرفوع لهذه الفاتورة';
  end if;

  if p_status = 'verified' then
    update public.invoices
    set receipt_status = 'verified',
        status = 'paid',
        updated_at = now()
    where id = p_invoice_id
    returning * into v_invoice;

    if v_invoice.order_id is not null then
      update public.orders
      set status = 'completed',
          updated_at = now()
      where id = v_invoice.order_id
        and tech_id = v_tech_id;
    end if;
  else
    update public.invoices
    set receipt_status = 'rejected',
        status = 'pending_payment',
        updated_at = now()
    where id = p_invoice_id
    returning * into v_invoice;

    if v_invoice.order_id is not null then
      update public.orders
      set status = 'awaiting_payment',
          updated_at = now()
      where id = v_invoice.order_id
        and tech_id = v_tech_id;
    end if;
  end if;

  return v_invoice;
end;
$$;

revoke all on function public.tech_verify_invoice_payment(bigint,text) from public, anon;
grant execute on function public.tech_verify_invoice_payment(bigint,text) to authenticated;

notify pgrst, 'reload schema';

commit;
