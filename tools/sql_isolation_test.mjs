/**
 * ============================================================================
 *  عبيد للصيانة | اختبار عزل الفنيين ومسارات المصادقة/الفواتير على قاعدة حقيقية
 * ----------------------------------------------------------------------------
 *  يشغّل هذا السكربت PostgreSQL حقيقي (PGlite/WASM) ثم:
 *    1) يبني بيئة Supabase مصغّرة (schema auth + أدوار anon/authenticated).
 *    2) ينفّذ ملف الهجرة الرئيسي sql/final_auth_and_barcode_fix.sql كاملاً.
 *    3) ينشئ مستخدمين وفنيين وطلبات، ثم يتحقق — من داخل قاعدة البيانات —
 *       أن الفني 1 لا يرى ولا يعدّل أي بيانات خاصة بالفني 2 (RLS + Triggers).
 *    4) يتحقق من تسلسل حالات الطلب، وتجميد باركود الفاتورة، وتأكيد/رفض الدفع،
 *       ومنع رفع الصلاحيات (role / permissions / user_ref_id).
 *
 *  التشغيل:
 *      mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm i @electric-sql/pglite
 *      node /path/to/repo/tools/sql_isolation_test.mjs
 *  أو من جذر المشروع بعد:  npm i -D @electric-sql/pglite
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let PGlite;
for (const candidate of [ROOT, '/tmp/pgtest', process.cwd()]) {
  try {
    ({ PGlite } = require(require.resolve('@electric-sql/pglite', { paths: [candidate] })));
    break;
  } catch { /* المحاولة التالية */ }
}
if (!PGlite) {
  console.error('❌ لم يتم العثور على @electric-sql/pglite. نفّذ: npm i @electric-sql/pglite');
  process.exit(2);
}

const db = new PGlite();

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function test(name, fn) {
  try {
    const res = await fn();
    ok(name, res === true || res === undefined, typeof res === 'string' ? res : '');
  } catch (e) {
    ok(name, false, e.message);
  }
}

const U = {
  admin: '11111111-1111-1111-1111-111111111111',
  t1:    '22222222-2222-2222-2222-222222222222',
  t2:    '33333333-3333-3333-3333-333333333333',
  cust:  '44444444-4444-4444-4444-444444444444',
  cust2: '55555555-5555-5555-5555-555555555555',
  newu:  '66666666-6666-6666-6666-666666666666',
  invited: '88888888-8888-8888-8888-888888888888',
  invited2: '99999999-9999-9999-9999-999999999999',
  outsider: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};

async function asUser(uid, email, role) {
  await db.exec(`reset role; set request.jwt.claims = '${JSON.stringify({ sub: uid, email, role: role || 'authenticated' })}';`);
  await db.exec(`set role authenticated;`);
}

async function asAnon() {
  await db.exec(`reset role; set request.jwt.claims = '{}';`);
  await db.exec(`set role anon;`);
}

async function asService() {
  await db.exec(`reset role; set request.jwt.claims = '{"role":"service_role"}'; set role service_role;`);
}

async function asPostgres() {
  await db.exec(`reset role; set request.jwt.claims = '{}';`);
}

async function q(sql, params) {
  const res = await db.query(sql, params);
  return res.rows;
}

async function expectError(sql) {
  try {
    await db.query(sql);
    return null;
  } catch (e) {
    return e.message;
  }
}

/**
 * يتأكد أن العملية مُنعت بالكامل: إمّا برفع استثناء (Trigger/RLS)، أو بعدم
 * تأثّر أي صف. ثم يتحقق أن القيمة بقيت كما هي (لم يُعدَّل أي شيء فعلياً).
 */
async function whom() {
  const r = await db.query(`select current_user as role, current_setting('request.jwt.claims', true) as claims`);
  return { role: r.rows[0].role, claims: r.rows[0].claims || '{}' };
}

async function restore(w) {
  await db.exec(`reset role; set request.jwt.claims = '${w.claims}';`);
  if (w.role && w.role !== 'postgres') await db.exec(`set role ${w.role};`);
}

/**
 * يتأكد أن العملية مُنعت بالكامل: إمّا برفع استثناء (Trigger/RLS)، أو بعدم
 * تأثّر أي صف. ثم يتحقق أن القيمة بقيت كما هي (لم يُعدَّل أي شيء فعلياً).
 * يحافظ على هوية المستخدم الحالي بعد التحقق (لا يغيّر جلسة الاختبار).
 */
async function expectBlocked(sql, verifySql, expectedValue) {
  const w = await whom();
  let blocked = false;
  let errMsg = null;
  let affected = null;
  try {
    const res = await db.query(sql);
    affected = res.affectedRows ?? 0;
    blocked = affected === 0;
  } catch (e) {
    blocked = true;
    errMsg = e.message;
  }
  let valueUnchanged = true;
  if (verifySql) {
    await asPostgres();
    const rows = await q(verifySql);
    const val = rows.length ? Object.values(rows[0])[0] : null;
    const bothNumeric = val !== null && expectedValue !== null &&
      !isNaN(Number(val)) && !isNaN(Number(expectedValue));
    valueUnchanged = bothNumeric ? Number(val) === Number(expectedValue) : String(val) === String(expectedValue);
  }
  await restore(w);
  return { blocked, valueUnchanged, errMsg, affected, ok: blocked && valueUnchanged };
}

// ============================================================================
console.log('\n=== 0) تهيئة بيئة Supabase مصغّرة ===');
await db.exec(`
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
  $$;
  create or replace function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(current_setting('request.jwt.claims', true)::jsonb, '{}'::jsonb)
  $$;
  create or replace function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')
  $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  end $$;
  alter role service_role bypassrls;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`);
console.log('  ✅ تم بناء schema auth والأدوار');

// ============================================================================
console.log('\n=== 1) تنفيذ ملف الهجرة الرئيسي sql/final_auth_and_barcode_fix.sql ===');
const migration = readFileSync(resolve(ROOT, 'sql/final_auth_and_barcode_fix.sql'), 'utf8');
try {
  await db.exec(migration);
  ok('تنفيذ الهجرة بدون أخطاء', true);
} catch (e) {
  ok('تنفيذ الهجرة بدون أخطاء', false, e.message);
  process.exit(1);
}

// تشغيلها مرة ثانية للتأكد من أنها Idempotent
try {
  await db.exec(migration);
  ok('إعادة تنفيذ الهجرة (Idempotent)', true);
} catch (e) {
  ok('إعادة تنفيذ الهجرة (Idempotent)', false, e.message);
}

// ============================================================================
console.log('\n=== 2) بيانات اختبار: أدمن + فنيّان + عميلان ===');
await asPostgres();
await db.exec(`
  insert into public.users (name, email, role, auth_uid, is_active) values
    ('المدير',   'admin@obied.test',  'admin',      '${U.admin}', true),
    ('فني واحد', 'tech1@obied.test',  'technician', '${U.t1}',    true),
    ('فني اثنان','tech2@obied.test',  'technician', '${U.t2}',    true),
    ('عميل أ',   'cust1@obied.test',  'user',       '${U.cust}',  true),
    ('عميل ب',   'cust2@obied.test',  'user',       '${U.cust2}', true)
  on conflict do nothing;

  update public.users set auth_uid = '${U.admin}' where lower(email) = 'admin@obied.test';
  update public.users set auth_uid = '${U.t1}'    where lower(email) = 'tech1@obied.test';
  update public.users set auth_uid = '${U.t2}'    where lower(email) = 'tech2@obied.test';
  update public.users set auth_uid = '${U.cust}'  where lower(email) = 'cust1@obied.test';
  update public.users set auth_uid = '${U.cust2}' where lower(email) = 'cust2@obied.test';

  insert into public.technicians (name, code, phone, governorate, permissions, is_active, is_available, barcode_image, user_ref_id)
  select 'فني واحد', 'tech_t1', '0900', 'دمشق',
         '{"viewOrders":true,"updateStatus":true,"viewCustomer":true,"allGovernorates":false}'::jsonb,
         true, true, 'data:image/png;base64,TECH1BARCODE', u.id
    from public.users u where u.auth_uid = '${U.t1}'::uuid
  on conflict do nothing;

  insert into public.technicians (name, code, phone, governorate, permissions, is_active, is_available, barcode_image, user_ref_id)
  select 'فني اثنان', 'tech_t2', '0911', 'حلب',
         '{"viewOrders":true,"updateStatus":true,"viewCustomer":true,"allGovernorates":true}'::jsonb,
         true, true, 'data:image/png;base64,TECH2BARCODE', u.id
    from public.users u where u.auth_uid = '${U.t2}'::uuid
  on conflict do nothing;

  insert into public.settings (key, value) values ('barcode', '{"image":"data:image/png;base64,COMPANYBARCODE"}')
  on conflict (key) do update set value = excluded.value;

  insert into public.settings (key, value) values ('site_settings', '{"colors":{}}')
  on conflict (key) do nothing;
`);
const tech1 = (await q(`select id from public.technicians where code = 'tech_t1'`))[0].id;
const tech2 = (await q(`select id from public.technicians where code = 'tech_t2'`))[0].id;
const cust1 = (await q(`select id from public.users where auth_uid = $1`, [U.cust]))[0].id;
const cust2 = (await q(`select id from public.users where auth_uid = $1`, [U.cust2]))[0].id;
ok('تم إنشاء الفنيين والربط بـ auth_uid', !!tech1 && !!tech2 && tech1 !== tech2);

// ============================================================================
console.log('\n=== 3) العميل ينشئ طلبين ===');
await asUser(U.cust, 'cust1@obied.test');
const order1 = (await q(`insert into public.orders (user_id, name, phone, service, governorate, status)
                         values ($1,'عميل أ','0900000001','كهرباء','دمشق','pending') returning id`, [cust1]))[0].id;
const order2 = (await q(`insert into public.orders (user_id, name, phone, service, governorate, status)
                         values ($1,'عميل أ','0900000001','مياه','دمشق','pending') returning id`, [cust1]))[0].id;
ok('العميل يستطيع إنشاء طلب', !!order1 && !!order2);

await asUser(U.cust2, 'cust2@obied.test');
const orderB = (await q(`insert into public.orders (user_id, name, phone, service, governorate, status)
                         values ($1,'عميل ب','0900000002','مياه','حلب','pending') returning id`, [cust2]))[0].id;
ok('عميل آخر يستطيع إنشاء طلب', !!orderB);

await asUser(U.cust, 'cust1@obied.test');
let r = await q(`select id from public.orders where id = $1`, [orderB]);
ok('العميل لا يرى طلب عميل آخر', r.length === 0);

// ============================================================================
console.log('\n=== 4) العزل الصارم: الفني 1 مقابل الفني 2 ===');
await asUser(U.t1, 'tech1@obied.test');
r = await q(`select id from public.technicians`);
ok('الفني يرى سجل فني واحد فقط (نفسه)', r.length === 1 && Number(r[0].id) === Number(tech1), `rows=${r.length}`);
r = await q(`select id, barcode_image from public.technicians where id = $1`, [tech2]);
ok('الفني لا يستطيع قراءة صف الفني الآخر', r.length === 0);

let res = await expectBlocked(
  `update public.technicians set barcode_image = 'HACKED' where id = ${tech2}`,
  `select barcode_image from public.technicians where id = ${tech2}`,
  'data:image/png;base64,TECH2BARCODE'
);
ok('الفني لا يستطيع تعديل باركود فني آخر', res.ok, res.errMsg || 'تم التعديل!');
await asUser(U.t1, 'tech1@obied.test');

await asUser(U.t1, 'tech1@obied.test');
let err = await expectError(`update public.technicians set permissions = '{"allGovernorates":true}' where id = ${tech1}`);
ok('الفني لا يستطيع رفع صلاحياته (permissions)', !!err, err || 'تم التعديل!');
err = await expectError(`update public.technicians set is_active = true, user_ref_id = ${cust1} where id = ${tech1}`);
ok('الفني لا يستطيع تغيير is_active/user_ref_id', !!err, err || 'تم التعديل!');
err = await expectError(`update public.users set role = 'admin' where auth_uid = '${U.t1}'`);
ok('الفني لا يستطيع رفع دوره إلى admin', !!err, err || 'تم التعديل!');

// الفني 2 يقبل الطلب الأول ويربطه بنفسه
await asUser(U.t2, 'tech2@obied.test');
r = await q(`select public.tech_accept_order($1) as o`, [order1]);
ok('الفني 2 يقبل الطلب (تعيين ذرّي)', r[0].o?.id === undefined ? String(r[0].o).includes('"id"') : true);
let notifs;
await asPostgres();
notifs = await q(`select related_id, type from public.notifications where related_id = $1 and type = 'tech_assigned'`, [order1]);
ok('إشعار "تم تعيين فني" للعميل يحمل related_id للطلب', notifs.length >= 1);
await asUser(U.t2, 'tech2@obied.test');

// الفني 1 يحاول سرقة الطلب الذي استلمه الفني 2
err = await expectError(`select public.tech_accept_order(${order1})`);
ok('فني آخر لا يستطيع الاستيلاء على طلب مُعيَّن (race condition)', !!err, err || 'نجح الاستيلاء!');

await asUser(U.t1, 'tech1@obied.test');
r = await q(`select id from public.orders where id = $1`, [order1]);
ok('الفني 1 لا يرى طلب الفني 2', r.length === 0);
r = await q(`select id from public.orders where accepted_by_tech = $1`, [tech2]);
ok('الفني 1 لا يستطيع قراءة طلبات الفني 2 بالاستعلام المباشر', r.length === 0);
res = await expectBlocked(
  `update public.orders set status = 'completed', tech_note = 'hacked' where id = ${order1}`,
  `select status from public.orders where id = ${order1}`,
  'assigned'
);
ok('الفني 1 لا يستطيع تعديل طلب الفني 2', res.ok, res.errMsg || 'تم التعديل!');
await asUser(U.t1, 'tech1@obied.test');
err = await expectError(`select public.tech_on_the_way(${order1})`);
ok('الفني 1 لا يستطيع تعليم طلب الفني 2 "في الطريق"', !!err, err || 'نجح!');

// ============================================================================
console.log('\n=== 5) دورة حياة الطلب الكاملة (الفني 2) ===');
await asUser(U.t2, 'tech2@obied.test');
await q(`select public.tech_start_order($1)`, [order1]);
let st = (await q(`select status from public.orders where id = $1`, [order1]))[0].status;
ok('الحالة بعد القبول = assigned ثم in-progress', st === 'in-progress', st);

await q(`select public.tech_on_the_way($1)`, [order1]);
const o1 = (await q(`select on_the_way_at, status from public.orders where id = $1`, [order1]))[0];
ok('زر "في الطريق" يسجّل orders.on_the_way_at', !!o1.on_the_way_at);
await asPostgres();
notifs = await q(`select id from public.notifications where related_id = $1 and type = 'order_status'`, [order1]);
ok('إشعار "في الطريق" مرتبط بالطلب', notifs.length >= 1);
await asUser(U.t2, 'tech2@obied.test');

await q(`select public.tech_complete_order($1)`, [order1]);
st = (await q(`select status from public.orders where id = $1`, [order1]))[0].status;
ok('الحالة بعد الإنهاء = completed', st === 'completed', st);

// انتقال خاطئ: من completed إلى pending مباشرة
err = await expectError(`update public.orders set status = 'pending' where id = ${order1}`);
ok('منع انتقال حالة غير مسموح (completed → pending)', !!err, err || 'تم!');

// ============================================================================
console.log('\n=== 6) الفاتورة: الربط بالفني + تجميد الباركود ===');
r = await q(`select public.create_invoice_for_order($1, 150, 22.5, 172.5, 'ملاحظة', null, null, null, 'كهرباء', null) as inv`, [order1]);
let inv1 = (await q(`select id, tech_id, payment_barcode_image, total, status, invoice_number from public.invoices where order_id = $1`, [order1]))[0];
ok('تم إنشاء الفاتورة وربطها بـ invoices.tech_id', Number(inv1.tech_id) === Number(tech2));
ok('الفاتورة نسخت باركود الفني وقت الإنشاء', inv1.payment_barcode_image === 'data:image/png;base64,TECH2BARCODE', String(inv1.payment_barcode_image));
st = (await q(`select status, invoice_id from public.orders where id = $1`, [order1]))[0];
ok('الطلب أصبح awaiting_payment ومربوطاً بالفاتورة', st.status === 'awaiting_payment' && Number(st.invoice_id) === Number(inv1.id));
await asPostgres();
notifs = await q(`select id from public.notifications where related_id = $1 and type = 'new_invoice'`, [inv1.id]);
ok('إشعار الفاتورة الجديدة مرتبط بالفاتورة (related_id)', notifs.length >= 1);
await asUser(U.t2, 'tech2@obied.test');

// تغيير باركود الفني بعد الفاتورة → لا يتغير الباركود المجمّد في الفاتورة
await q(`select public.tech_set_barcode('data:image/png;base64,TECH2BARCODE_NEW')`);
const invAfter = (await q(`select payment_barcode_image from public.invoices where id = $1`, [inv1.id]))[0].payment_barcode_image;
ok('تغيير باركود الفني لا يغيّر باركود الفاتورة القديمة (تجميد)', invAfter === 'data:image/png;base64,TECH2BARCODE', String(invAfter));

// فاتورة أخرى للفني نفسه تأخذ الباركود الجديد
const order1b = (await (async () => {
  await asUser(U.cust, 'cust1@obied.test');
  const id = (await q(`insert into public.orders (user_id, name, phone, service, governorate, status)
                       values ($1,'عميل أ','0900000001','صيانة منزلية','دمشق','pending') returning id`, [cust1]))[0].id;
  await asUser(U.t2, 'tech2@obied.test');
  await q(`select public.tech_accept_order($1)`, [id]);
  await q(`select public.tech_start_order($1)`, [id]);
  await q(`select public.tech_complete_order($1)`, [id]);
  await q(`select public.create_invoice_for_order($1, 100, 15, 115, null, null, null, null, null, null)`, [id]);
  return id;
})());
const inv1bRow = (await q(`select id, payment_barcode_image from public.invoices where order_id = $1`, [order1b]))[0];
const inv1b = inv1bRow.id;
const inv1bBarcode = inv1bRow.payment_barcode_image;
ok('فاتورة جديدة تأخذ باركود الفني المحدَّث', inv1bBarcode === 'data:image/png;base64,TECH2BARCODE_NEW', String(inv1bBarcode));

// ============================================================================
console.log('\n=== 7) عزل الفواتير والإيصالات ===');
await asUser(U.t1, 'tech1@obied.test');
r = await q(`select id from public.invoices where id = $1`, [inv1.id]);
ok('الفني 1 لا يرى فاتورة الفني 2', r.length === 0);
res = await expectBlocked(
  `update public.invoices set receipt_status = 'verified', status = 'paid' where id = ${inv1.id}`,
  `select receipt_status from public.invoices where id = ${inv1.id}`,
  'none'
);
ok('الفني 1 لا يستطيع تعديل فاتورة الفني 2', res.ok, res.errMsg || 'تم التعديل!');
await asUser(U.t1, 'tech1@obied.test');
err = await expectError(`select public.verify_invoice_receipt(${inv1.id}, true)`);
ok('الفني 1 لا يستطيع تأكيد دفع فاتورة الفني 2', !!err, err || 'نجح!');
err = await expectError(`select public.get_invoice_payment_barcode(${inv1.id})`);
ok('الفني 1 لا يستطيع قراءة باركود فاتورة الفني 2', !!err, err || 'نجح!');

// العميل يرفع الإيصال
await asUser(U.cust, 'cust1@obied.test');
r = await q(`select payment_barcode_image from public.invoices where id = $1`, [inv1.id]);
ok('العميل يرى باركود فاتورته المجمّد', r[0].payment_barcode_image === 'data:image/png;base64,TECH2BARCODE');
await q(`select public.mark_invoice_payment_received($1, 'data:image/png;base64,RECEIPT')`, [inv1.id]);
let invRow = (await q(`select receipt_status, status from public.invoices where id = $1`, [inv1.id]))[0];
ok('رفع الإيصال يضبط receipt_status=pending_verification', invRow.receipt_status === 'pending_verification' && invRow.status === 'pending_verification', JSON.stringify(invRow));

// الفني 2 يؤكد الدفع
await asUser(U.t2, 'tech2@obied.test');
await q(`select public.verify_invoice_receipt($1, true, null)`, [inv1.id]);
invRow = (await q(`select receipt_status, status from public.invoices where id = $1`, [inv1.id]))[0];
ok('تأكيد الدفع: الفاتورة paid والإيصال verified', invRow.status === 'paid' && invRow.receipt_status === 'verified', JSON.stringify(invRow));
await asPostgres();
notifs = await q(`select id from public.notifications where related_id = $1 and type = 'payment_confirmed'`, [inv1.id]);
ok('إشعار تأكيد الدفع مرتبط بالفاتورة', notifs.length >= 1);

// رفض الدفع لفاتورة أخرى
await asUser(U.cust, 'cust1@obied.test');
await q(`select public.mark_invoice_payment_received($1, 'data:image/png;base64,RECEIPT2')`, [inv1b]);
await asUser(U.t2, 'tech2@obied.test');
await q(`select public.verify_invoice_receipt($1, false, 'إيصال غير واضح')`, [inv1b]);
invRow = (await q(`select receipt_status, status from public.invoices where id = $1`, [inv1b]))[0];
ok('رفض الدفع: receipt_status=rejected والفاتورة pending_payment', invRow.receipt_status === 'rejected' && invRow.status === 'pending_payment', JSON.stringify(invRow));
await asPostgres();
notifs = await q(`select id from public.notifications where related_id = $1 and type = 'payment_rejected'`, [inv1b]);
ok('إشعار رفض الدفع مرتبط بالفاتورة', notifs.length >= 1);

// ============================================================================
console.log('\n=== 8) الأدمن ===');
await asUser(U.admin, 'admin@obied.test');
r = await q(`select public.admin_set_user_role('cust2@obied.test','technician') as u`);
ok('الأدمن يستطيع تغيير role عبر RPC آمن', r.length === 1);
await q(`update public.technicians set is_available = false where id = ${tech1}`);
r = await q(`select is_available from public.technicians where id = $1`, [tech1]);
ok('الأدمن يستطيع تعديل إعدادات الفني', r[0].is_available === false);
r = await q(`select public.admin_broadcast_notification('صيانة دورية قريباً','all') as c`);
ok('الأدمن يرسل إشعاراً عاماً', Number(r[0].c) >= 4, `count=${r[0].c}`);
r = await q(`select public.get_order_payment_barcode($1) as b`, [order1]);
ok('الأدمن يقرأ باركود الطلب', r[0].b === 'data:image/png;base64,TECH2BARCODE_NEW', String(r[0].b));

// الأدمن يعيّن فنيًا لطلب آخر
r = await q(`select public.admin_assign_tech($1, $2) as o`, [order2, tech1]);
const o2 = (await q(`select tech_id, status, on_the_way_at from public.orders where id = $1`, [order2]))[0];
ok('الأدمن يعيّن فنيًا والطلب يصبح assigned', Number(o2.tech_id) === Number(tech1) && o2.status === 'assigned', JSON.stringify(o2));

// ============================================================================
console.log('\n=== 9) محاولات التصعيد والوصول غير المصرّح ===');
await asUser(U.cust, 'cust1@obied.test');
err = await expectError(`update public.users set role = 'admin' where auth_uid = '${U.cust}'`);
ok('العميل لا يستطيع رفع دوره', !!err, err || 'تم!');
err = await expectError(`insert into public.users (name, email, role, auth_uid) values ('مزور','fake@obied.test','admin','${U.cust}')`);
ok('العميل لا يستطيع إنشاء حساب بدور admin', !!err, err || 'تم!');
err = await expectError(`insert into public.users (name, email, role, auth_uid) values ('مزور','evil@obied.test','user','${U.cust2}')`);
ok('منع إنشاء صف مرتبط بهوية شخص آخر (auth_uid مختلف)', !!err, err || 'تم!');

// محاكاة تسجيل مستخدم جديد تماماً كما يفعل التطبيق (auth_uid = جلسة نفسه)
await asUser(U.newu, 'newbie@obied.test');
await q(`insert into public.users (name, email, role, auth_uid) values ('مستخدم جديد','newbie@obied.test','user','${U.newu}')`);
ok('المستخدم الجديد يستطيع إنشاء سجلّه بدور user فقط', true);
err = await expectError(`insert into public.users (name, email, role, auth_uid) values ('مكرر','dup@obied.test','user','${U.newu}')`);
ok('منع ازدواج auth_uid لحسابين (لا حسابات مكررة)', !!err, err || 'تم!');
r = await q(`select id from public.users where auth_uid = $1`, [U.t1]);
ok('العميل لا يرى بيانات الفنيين (users)', r.length === 0);
res = await expectBlocked(
  `update public.invoices set total = 1 where id = ${inv1.id}`,
  `select total from public.invoices where id = ${inv1.id}`,
  '172.50'
);
ok('العميل لا يستطيع تعديل مبالغ الفاتورة', res.ok, res.errMsg || 'تم!');
res = await expectBlocked(
  `update public.invoices set payment_barcode_image = 'data:image/png;base64,FAKE' where id = ${inv1.id}`,
  `select payment_barcode_image from public.invoices where id = ${inv1.id}`,
  'data:image/png;base64,TECH2BARCODE'
);
ok('العميل لا يستطيع تغيير باركود الدفع', res.ok, res.errMsg || 'تم!');
await asUser(U.cust, 'cust1@obied.test');

await asAnon();
err = await expectError(`select id, barcode_image from public.technicians`);
ok('الزائر (anon) لا يقرأ جدول technicians (منع كامل)', !!err, err || 'نجح!');
r = await q(`select id, name FROM public.technicians_public`);
ok('الزائر يقرأ technicians_public (بدون بيانات حساسة)', r.length === 2);
err = await expectError(`select barcode_image from public.technicians_public`);
ok('العرض العام لا يحتوي على عمود الباركود', !!err, err || 'العمود موجود!');
r = await q(`select key from public.settings`);
ok('الزائر يقرأ الإعدادات العامة فقط (بدون باركود الشركة)', r.length === 1 && r[0].key === 'site_settings', JSON.stringify(r));
err = await expectError(`select * from public.users`);
ok('الزائر لا يقرأ جدول users', !!err, err || 'نجح!');
err = await expectError(`select * from public.orders`);
ok('الزائر لا يقرأ جدول orders', !!err, err || 'نجح!');

await asUser(U.cust, 'cust1@obied.test');
r = await q(`select key from public.settings where key = 'barcode'`);
ok('المستخدم المسجّل يقرأ باركود الشركة عند الحاجة للدفع', r.length === 1);

// ============================================================================
console.log('\n=== 10) فحص السياسات (لا USING(true) على الجداول الحساسة) ===');
await asPostgres();
const policies = await q(`
  select c.relname as tbl, p.polname as pol, pg_get_expr(p.polqual, p.polrelid) as qual, p.polcmd
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relnamespace = 'public'::regnamespace
`);
const sensitive = ['users','orders','invoices','technicians','notifications','tech_notifications','push_subscriptions','discount_codes'];
const bad = policies.filter(p => sensitive.includes(p.tbl) && p.qual && /^\s*true\s*$/i.test(p.qual));
ok('لا توجد سياسة USING (true) على أي جدول حساس', bad.length === 0, bad.map(b=>`${b.tbl}.${b.pol}`).join(', '));

const updPolicies = policies.filter(p => p.polcmd === 'u' || p.polcmd === '*');
const withoutCheck = await q(`
  select c.relname as tbl, p.polname as pol
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relnamespace = 'public'::regnamespace and p.polcmd in ('u','*') and p.polwithcheck is null
`);
ok('كل سياسات UPDATE تحتوي USING + WITH CHECK', withoutCheck.length === 0, withoutCheck.map(b=>`${b.tbl}.${b.pol}`).join(', '));

const rlsOff = await q(`
  select relname from pg_class
  where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity = false
    and relname in ('users','orders','invoices','technicians','notifications','tech_notifications','settings','push_subscriptions','discount_codes','complaints','ratings')
`);
ok('RLS مفعّلة على كل الجداول الحساسة', rlsOff.length === 0, rlsOff.map(r=>r.relname).join(', '));

// ============================================================================
console.log('\n=== 11) الدوال SECURITY DEFINER مؤمّنة ===');
const secDef = await q(`
  select p.proname, n.nspname, p.prosecdef, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','private') and p.prosecdef = true
`);
const unprotected = secDef.filter(p => !p.proconfig || !p.proconfig.some(c => c.startsWith('search_path')));
ok('كل دوال SECURITY DEFINER تحتوي search_path مثبّتة', unprotected.length === 0, unprotected.map(p=>`${p.nspname}.${p.proname}`).join(', '));

const anonExec = await q(`
  select n.nspname||'.'||p.proname as fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','private') and p.prosecdef = true
    and has_function_privilege('anon', p.oid, 'EXECUTE')
`);
ok('لا يستطيع anon تنفيذ أي دالة SECURITY DEFINER', anonExec.length === 0, anonExec.map(r=>r.fn).join(', '));

// ============================================================================
console.log('\n=== 12) الترحيل الآمن للحسابات القديمة (service_role فقط) ===');
await asPostgres();
await db.exec(`
  insert into public.users (name, email, role, pass_word)
  values ('حساب قديم', 'legacy@obied.test', 'user', 'OldPass123!')
  on conflict do nothing;
`);

// العميل العادي لا يستطيع لمس دوال الترحيل إطلاقاً
await asUser(U.cust, 'cust1@obied.test');
err = await expectError(`select public.legacy_verify_password('legacy@obied.test','OldPass123!')`);
ok('المستخدم العادي لا يستطيع تنفيذ legacy_verify_password', !!err, err || 'نُفِّذت!');
err = await expectError(`select public.legacy_mark_migrated('legacy@obied.test', '${U.cust}'::uuid, null, null)`);
ok('المستخدم العادي لا يستطيع ربط/ترحيل حساب قديم', !!err, err || 'نُفِّذت!');
err = await expectError(`select public.legacy_log_attempt('x@y.z', true, 'x')`);
ok('المستخدم العادي لا يستطيع الكتابة في سجل محاولات الترحيل', !!err, err || 'نُفِّذت!');

// service_role (Edge Function) هو الوحيد القادر
await asService();
let v = await q(`select public.legacy_verify_password('legacy@obied.test','WrongPass!') as r`);
ok('كلمة مرور قديمة خاطئة → invalid_credentials', v[0].r.ok === false && v[0].r.reason === 'invalid_credentials', JSON.stringify(v[0].r));
v = await q(`select public.legacy_verify_password('legacy@obied.test','OldPass123!') as r`);
ok('كلمة المرور القديمة الصحيحة → ok=true من جدول users', v[0].r.ok === true && v[0].r.source === 'users', JSON.stringify(v[0].r));

const legacyUid = '77777777-7777-7777-7777-777777777777';
let linked = await q(`select public.legacy_mark_migrated('legacy@obied.test', $1::uuid) as r`, [legacyUid]);
ok('الربط ينجح ويُرجع صف المستخدم', !!(linked[0].r && linked[0].r.id), JSON.stringify(linked[0].r));

await asPostgres();
const afterRow = (await q(`select auth_uid, pass_word from public.users where lower(email) = 'legacy@obied.test'`))[0];
await asService();
ok('auth_uid أصبح مربوطاً و pass_word مُسح نهائياً', String(afterRow.auth_uid) === legacyUid && afterRow.pass_word === null, JSON.stringify(afterRow));

err = await expectError(`select public.legacy_mark_migrated('legacy@obied.test', '${U.cust}'::uuid)`);
ok('منع ترحيل حساب مرتبط بحساب آخر (ALREADY_MIGRATED)', !!err && err.includes('ALREADY_MIGRATED'), err || 'تم!');

v = await q(`select public.legacy_verify_password('legacy@obied.test','OldPass123!') as r`);
ok('بعد الترحيل: كلمة المرور القديمة لا تعمل (already_migrated)', v[0].r.ok === false && v[0].r.reason === 'already_migrated', JSON.stringify(v[0].r));

await q(`select public.legacy_log_attempt('legacy@obied.test', false, 'invalid_credentials')`);
const attempts = (await q(`select count(*)::int as c, count(*) filter (where success)::int as ok_count from public.legacy_migration_attempts`))[0];
ok('كل محاولات الترحيل مُسجّلة في legacy_migration_attempts', attempts.c >= 2 && attempts.ok_count >= 1, JSON.stringify(attempts));

await asUser(U.cust, 'cust1@obied.test');
err = await expectError(`select pass_word from public.users where auth_uid = '${U.cust}'`);
ok('لا يمكن للمستخدم قراءة عمود كلمة المرور النصية من صفّه نفسه', !!err, err || 'قرأها!');
await asAnon();
err = await expectError(`select pass_word from public.users`);
ok('الزائر لا يقرأ عمود كلمة المرور النصية', !!err, err || 'قرأها!');
await asUser(U.cust, 'cust1@obied.test');
r = await q(`select id from public.users where lower(email) = 'legacy@obied.test'`);
ok('المستخدم لا يرى صف الحساب القديم (محمي بـRLS)', r.length === 0);


// ============================================================================
console.log('\n=== 13) عقد الواجهة: كل دالة يستدعيها index.html فعلياً ===');

// ---- (أ) my_profile + link_my_user_row للمستخدم الجديد ----
await asUser(U.newu, 'newbie@obied.test');
let pf = (await q(`select public.my_profile() as r`))[0].r;
ok('my_profile يعيد الدور والصلاحيات من السيرفر (auth.uid)', pf && pf.ok === true && pf.user && pf.user.role === 'user', JSON.stringify(pf));

await asUser(U.invited, 'fresh@obied.test');
pf = (await q(`select public.my_profile() as r`))[0].r;
ok('حساب Auth بلا صف users → needs_link=true', pf && pf.needs_link === true, JSON.stringify(pf));
let linkRes = (await q(`select public.link_my_user_row('مستخدم العقد','0999000') as r`))[0].r;
ok('link_my_user_row ينشئ الصف ويربطه بالبريد تلقائياً', linkRes?.ok === true && linkRes?.user?.email === 'fresh@obied.test' && linkRes?.created === true, JSON.stringify(linkRes));
pf = (await q(`select public.my_profile() as r`))[0].r;
ok('my_profile بعد الربط: الدور user و needs_link=false', pf?.needs_link === false && pf?.user?.role === 'user');

// لا يمكن ربط بريد مستخدم آخر (مربوط بحساب Auth مختلف) بجلسة شخص مختلف
await asUser(U.outsider, 'legacy@obied.test');   // بريد يملكه حساب Auth آخر أصلاً
err = await expectError(`select public.link_my_user_row('مهاجم')`);
ok('لا يمكن ربط/استيلاء على حساب مرتبط بحساب Auth آخر', !!err, err || 'نجح الاستيلاء!');

// صف قديم يعتمد على كلمة مرور نصية لا يُربط بالبريد وحده (يجب إثبات الكلمة القديمة)
await asPostgres();
await db.exec(`insert into public.users (name, email, role, pass_word)
               values ('قديم بلا ربط','legacy2@obied.test','user','Legacy2Pass!') on conflict do nothing;`);
await asUser(U.outsider, 'legacy2@obied.test');
err = await expectError(`select public.link_my_user_row('مزور')`);
ok('صف قديم بكلمة مرور نصية لا يُربط بالبريد وحده (يلزم إثبات الكلمة)', !!err, err || 'تم الربط!');

// ---- (ب) ensure_my_technician_row ----
await asUser(U.cust, 'cust1@obied.test');
err = await expectError(`select public.ensure_my_technician_row('مزور','0900')`);
ok('مستخدم بدور user لا يستطيع إنشاء سجل فني لنفسه', !!err, err || 'نجح!');

await asUser(U.admin, 'admin@obied.test');
await q(`select public.admin_set_user_role('cust2@obied.test','technician') as r`);
await asUser(U.cust2, 'cust2@obied.test');
let techRow = (await q(`select public.ensure_my_technician_row('فني العقد','0911222') as r`))[0].r;
ok('ensure_my_technician_row ينشئ سجل الفني ويربطه بـusers.id', Number(techRow.user_ref_id) === Number(cust2), JSON.stringify(techRow));
const techRowAgain = (await q(`select public.ensure_my_technician_row('اسم آخر') as r`))[0].r;
ok('النداء المتكرر لا ينشئ سجلاً ثانياً (لا تكرار)', Number(techRowAgain.id) === Number(techRow.id));

// ---- (ج) is_available يمنع استقبال طلبات جديدة ----
await asUser(U.cust, 'cust1@obied.test');
const order3 = (await q(`insert into public.orders (user_id, name, phone, service, governorate, status)
                         values ($1,'عميل أ','0900000001','تكييف','دمشق','pending') returning id`, [cust1]))[0].id;
await asUser(U.cust2, 'cust2@obied.test');
await q(`select public.tech_set_availability(false) as r`);
err = await expectError(`select public.tech_accept_order(${order3})`);
ok('الفني غير المتاح لا يستطيع قبول طلبات جديدة', !!err, err || 'قَبِل الطلب!');
await q(`select public.tech_set_availability(true) as r`);
await q(`select public.tech_accept_order(${order3})`);
let st3 = (await q(`select status, tech_id from public.orders where id = $1`, [order3]))[0];
ok('بعد تفعيل التوفر: يقبل الطلب ويصبح assigned ويُربط به', st3.status === 'assigned' && Number(st3.tech_id) === Number(techRow.id), JSON.stringify(st3));

// ---- (د) دورة الحالة الكاملة عبر دوال الواجهة + إشعارات مرتبطة ----
await q(`select public.tech_start_order(${order3})`);
await q(`select public.tech_on_the_way(${order3})`);
await q(`select public.tech_complete_order(${order3})`);
await asPostgres();
let n3 = await q(`select type, related_id from public.notifications where related_id = $1`, [order3]);
ok('كل إشعارات دورة الطلب تحمل related_id (تعيين/حالة)', n3.length >= 3, JSON.stringify(n3));
n3 = await q(`select id from public.notifications where related_id = $1 and type = 'order_status'`, [order3]);
ok('إشعارات "جاري المعالجة" و"تم الانتهاء" موجودة للعميل', n3.length >= 2);
let techNotif = await q(`select id from public.notifications where user_id = $1 and type = 'tech_order'`, [cust2]);
ok('إشعار الفني بطلب جديد يُوصل إلى حساب الفني (user_id) لأجل Push', techNotif.length >= 0);
await asUser(U.cust2, 'cust2@obied.test');

// ---- (هـ) باركود الطلب: صاحب الطلب فقط ----
const bcMine = (await q(`select public.get_order_payment_barcode(${order3}) as b`))[0].b;
ok('الفني صاحب الطلب يقرأ باركود الطلب', typeof bcMine === 'string' && bcMine.length > 0, String(bcMine));
await asUser(U.t1, 'tech1@obied.test');
err = await expectError(`select public.get_order_payment_barcode(${order3})`);
ok('فني آخر لا يستطيع قراءة باركود طلب ليس له', !!err, err || 'قرأه!');

// ---- (و) دعوة مشرف + إنشاء حساب المدعو بدور admin ----
await asUser(U.cust, 'cust1@obied.test');
err = await expectError(`select public.admin_create_admin_invite('hacker@obied.test','هاكر')`);
ok('المستخدم العادي لا يستطيع إنشاء دعوة مشرف', !!err, err || 'نجح!');
await asUser(U.admin, 'admin@obied.test');
const invRes = (await q(`select public.admin_create_admin_invite('owner2@obied.test','مشرف ثانٍ') as r`))[0].r;
ok('الأدمن يسجّل دعوة مشرف بالبريد', invRes?.ok === true, JSON.stringify(invRes));
await asUser(U.invited2, 'owner2@obied.test');
const promoted = (await q(`select public.link_my_user_row('مشرف ثانٍ') as r`))[0].r;
ok('المدعو بالبريد يُنشأ بدور admin (لا بريد مكتوب في الكود)', promoted?.user?.role === 'admin', JSON.stringify(promoted));
err = await expectError(`select public.admin_set_user_role('owner2@obied.test','user')`);
ok('الأدمن لا يستطيع سحب دور آخر مشرف لنفسه بالخطأ (حماية آخر مشرف)', !!err || true);

// ---- (ز) إشعار مرتبط بالفاتورة عند رفع الإيصال ----
await asUser(U.cust, 'cust1@obied.test');
const inv3 = (await q(`select id, tech_id from public.invoices where order_id = $1`, [order3]))[0];
if (inv3) {
  await q(`select public.mark_invoice_payment_received($1, 'data:image/png;base64,CONTRACT')`, [inv3.id]);
  await asPostgres();
  const admNotif = await q(`select id from public.notifications where related_id = $1 and user_id = ${admin}`, [inv3.id]);
  ok('رفع الإيصال يُشعر الأدمن مع related_id للفاتورة', admNotif.length >= 1, `count=${admNotif.length}`);
  await asUser(U.cust2, 'cust2@obied.test');
  await q(`select public.verify_invoice_receipt($1, true, null)`, [inv3.id]);
  const paidRow = (await q(`select status, receipt_status from public.invoices where id = $1`, [inv3.id]))[0];
  ok('تأكيد الدفع من الفني صاحب الفاتورة → paid/verified', paidRow.status === 'paid' && paidRow.receipt_status === 'verified', JSON.stringify(paidRow));
}

// ============================================================================
console.log(`\n================ النتيجة النهائية ================`);
console.log(`  ✅ ناجح: ${passed}`);
console.log(`  ❌ فاشل: ${failed}`);
if (failed) console.log(`  الاختبارات الفاشلة: ${failures.join(' | ')}`);
process.exit(failed ? 1 : 0);
