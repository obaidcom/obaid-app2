-- عبيد للصيانة: إضافة النواحي إلى الحجوزات
-- المصدر المرجعي للبيانات: OpenSyria Data Geography v0.1.5
-- 14 محافظة / 62 منطقة / 272 ناحية
alter table public.orders add column if not exists subdistrict text;

create or replace function public.prevent_tech_order_tamper()
returns trigger language plpgsql security definer set search_path to ''
as $function$
declare v_role text; v_tech_id bigint;
begin
  v_role := (select private.my_role()); v_tech_id := (select private.my_tech_id());
  if v_role = 'admin' then return new; end if;
  if v_role <> 'technician' then return new; end if;
  if v_tech_id is null then raise exception 'حساب الفني غير صالح'; end if;

  if old.status = 'pending' and old.accepted_by_tech is null and (old.tech_id is null or old.tech_id = v_tech_id) then
    if new.accepted_by_tech is distinct from v_tech_id or new.tech_id is distinct from v_tech_id or new.status not in ('accepted','in-progress') then
      raise exception 'غير مسموح بقبول الطلب بهذه القيم';
    end if;
    if old.user_id is distinct from new.user_id or old.name is distinct from new.name or old.phone is distinct from new.phone
       or old.service is distinct from new.service or old.date is distinct from new.date or old.time is distinct from new.time
       or old.governorate is distinct from new.governorate or old.district is distinct from new.district
       or old.subdistrict is distinct from new.subdistrict or old.address is distinct from new.address
       or old.latitude is distinct from new.latitude or old.longitude is distinct from new.longitude
       or old.notes is distinct from new.notes or old.photo is distinct from new.photo
       or old.invoice_id is distinct from new.invoice_id or old.invoice_number is distinct from new.invoice_number
       or old.invoice_amount is distinct from new.invoice_amount or old.payment_method is distinct from new.payment_method
       or old.created_at is distinct from new.created_at then
      raise exception 'الفني لا يستطيع تعديل بيانات الطلب أو العميل أثناء القبول';
    end if;
    return new;
  end if;

  if old.tech_id is distinct from v_tech_id or old.accepted_by_tech is distinct from v_tech_id then
    raise exception 'لا يمكنك تعديل طلب فني آخر';
  end if;

  if old.user_id is distinct from new.user_id or old.name is distinct from new.name or old.phone is distinct from new.phone
     or old.service is distinct from new.service or old.date is distinct from new.date or old.time is distinct from new.time
     or old.governorate is distinct from new.governorate or old.district is distinct from new.district
     or old.subdistrict is distinct from new.subdistrict or old.address is distinct from new.address
     or old.latitude is distinct from new.latitude or old.longitude is distinct from new.longitude
     or old.notes is distinct from new.notes or old.photo is distinct from new.photo
     or old.tech_id is distinct from new.tech_id or old.accepted_by_tech is distinct from new.accepted_by_tech
     or old.tech_name is distinct from new.tech_name or old.tech_phone is distinct from new.tech_phone
     or old.tech_accepted_at is distinct from new.tech_accepted_at or old.created_at is distinct from new.created_at then
    raise exception 'الفني لا يستطيع تعديل بيانات الطلب الأساسية';
  end if;
  return new;
end;
$function$;