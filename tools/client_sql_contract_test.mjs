#!/usr/bin/env node
// ============================================================================
//  obaid-app2 — اختبار العقد بين الواجهة (index.html) وقاعدة البيانات (SQL)
// ============================================================================
//  يتحقق من:
//    1) كل دالة RPC يستدعيها index.html/reset-password.html موجودة في SQL.
//    2) كل جدول/عرض يستخدمه العميل موجود في SQL.
//    3) الكتابة المباشرة من العميل محصورة في مسارات محمية بـRLS (وإلا يُفشل الاختبار).
//    4) لا أسرار ولا كلمات مرور نصية ولا بريد أدمن في الكود.
//    5) localStorage ليس مصدر مصادقة.
//    6) سياسات RLS والمشغّلات (Triggers) المطلوبة موجودة فعلاً في SQL.
//
//  التشغيل:  node tools/client_sql_contract_test.mjs
//  الخروج:   0 = ناجح، 1 = يوجد فشل
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML_FILES = ['index.html', 'reset-password.html'];
const SQL_FILES = [
  'sql/final_auth_and_barcode_fix.sql',
  'sql/real_auth_migration_and_rls.sql',
  'sql/security_hardening_v2.sql',
  'sql/new_features_setup.sql',
  'sql/push_setup.sql',
];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = HTML_FILES.filter(f => fs.existsSync(path.join(ROOT, f))).map(read).join('\n');
const indexHtml = read('index.html');
const sql = SQL_FILES.filter(f => fs.existsSync(path.join(ROOT, f))).map(read).join('\n');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail && !ok ? '  → ' + detail : ''}`);
}
// يجد اسم الدالة (function) المحتوية على موضع معيّن في الملف
function enclosingFunction(src, index) {
  const before = src.slice(0, index);
  const matches = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g)];
  return matches.length ? matches[matches.length - 1][1] : '(top-level)';
}
function writeSites(src, table) {
  const out = [];
  // نمنع امتداد المطابقة إلى عبارة أخرى: لا يُسمح بـ .from( بين الاستدعاء والعملية
  const re = new RegExp(`\\.from\\(\\s*['"]${table}['"]\\s*\\)(?:(?!\\.from\\()[\\s\\S]){0,300}?\\.(insert|update|delete|upsert)\\(`, 'g');
  let m;
  while ((m = re.exec(src))) out.push({ fn: enclosingFunction(src, m.index), op: m[1], at: m.index });
  return out;
}

// ---------------------------------------------------------------- 1) RPC
console.log('\n=== 1) دوال RPC المستدعاة من الواجهة ===');
const rpcCalls = [...new Set([...html.matchAll(/sb\.rpc\(\s*['"]([A-Za-z0-9_]+)['"]/g)].map(m => m[1]))].sort();
const missingRpcs = rpcCalls.filter(fn => !new RegExp(`function\\s+(public\\.)?${fn}\\s*\\(`, 'i').test(sql));
check(`${rpcCalls.length} دالة RPC مستدعاة — كلها معرَّفة في SQL`, missingRpcs.length === 0, missingRpcs.join(', '));
console.log('     ' + rpcCalls.join(', '));

// ---------------------------------------------------------------- 2) الجداول
console.log('\n=== 2) الجداول والعروض المستخدمة من الواجهة ===');
const tables = [...new Set([...html.matchAll(/sb\s*\n?\s*\.from\(\s*['"]([A-Za-z0-9_]+)['"]/g)].map(m => m[1]))].sort();
const missingTables = tables.filter(t =>
  !new RegExp(`create\\s+(or\\s+replace\\s+)?(table|view)\\s+(if not exists\\s+)?(public\\.)?${t}\\b`, 'i').test(sql));
check(`${tables.length} جدول/عرض — كلها معرَّفة في SQL`, missingTables.length === 0, missingTables.join(', '));
console.log('     ' + tables.join(', '));

// ------------------------------------------- 3) الكتابة المباشرة على الجداول الحساسة
console.log('\n=== 3) الكتابة المباشرة من العميل على الجداول الحساسة ===');
const ADMIN_TECH_FNS = ['assignUserAsTech', 'showAssignTechFromEmail', 'addNewTechnician', 'saveTechEdit', 'toggleTechStatus', 'deleteTechnician', 'saveTechPermissions'];
const techWrites = writeSites(indexHtml, 'technicians');
const badTechWrites = techWrites.filter(w => !ADMIN_TECH_FNS.includes(w.fn));
check(`كتابة technicians محصورة في مسارات لوحة الإدارة (${ADMIN_TECH_FNS.length} دالة)`,
  badTechWrites.length === 0, badTechWrites.map(w => `${w.fn}:${w.op}`).join(', '));

check('لا إدراج مباشر لفواتير من العميل (الإنشاء عبر create_invoice_for_order)',
  writeSites(indexHtml, 'invoices').filter(w => w.op === 'insert' || w.op === 'upsert').length === 0);

const techZone = indexHtml.slice(indexHtml.indexOf('async function techAcceptOrder'), indexHtml.indexOf('function techCallCustomer'));
check('لوحة الفني لا تكتب في orders/invoices بتحديث مباشر',
  !/\.from\(\s*['"](orders|invoices)['"]\s*\)[\s\S]{0,200}?\.(update|insert)\(/.test(techZone));

check('لا تعديل مباشر لدور المستخدم في users من العميل',
  !/\.from\(\s*['"]users['"]\s*\)[\s\S]{0,200}?\.update\(\s*\{[^}]*\brole\s*:/.test(indexHtml));

// ------------------------------------------------ 4) الأسرار وكلمات المرور
console.log('\n=== 4) الأسرار وكلمات المرور النصية ===');
check('لا يوجد service_role في الواجهة', !/service_role/i.test(html));
check('لا يوجد مفتاح FCM/Service Account في الواجهة', !/FCM_SERVICE_ACCOUNT|private_key|client_email/i.test(html));
check('لا يُخزَّن pass_word في قاعدة البيانات من الواجهة', !/pass_word\s*:/.test(html));
check('لا قراءة لعمود pass_word من الواجهة', !/select\([^)]*pass_word/i.test(html));
check('لا جدول admins بكلمات مرور نصية في الواجهة', !/from\(\s*['"]admins['"]/.test(html));
check('لا بريد أدمن مكتوب في منطق المصادقة',
  ![...indexHtml.matchAll(/^.*(?:role\s*[:=]\s*['"]admin|isAdmin\s*=|adminEmail\s*=).*$/gm)]
    .some(m => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(m[0])));

// ------------------------------------------------ 5) localStorage كمصدر مصادقة
console.log('\n=== 5) localStorage ليس مصدر مصادقة ===');
for (const key of ['obied_current_user', 'obied_admin', 'obied_tech', 'obied_tech_unlocked']) {
  const writes = [...indexHtml.matchAll(new RegExp(`localStorage\\.setItem\\(\\s*['"]${key}['"]`, 'g'))];
  check(`لا يُكتب مفتاح المصادقة ${key} في localStorage`, writes.length === 0, `عدد المواضع: ${writes.length}`);
}
check('رمز الفني العام القديم محذوف', !/tech2024/.test(indexHtml));
check('كلمة المرور لا تُمرَّر إلى جدول users', !/from\(\s*['"]users['"]\s*\)[\s\S]{0,200}?password\s*:/.test(indexHtml));

// ------------------------------------------------ 6) تسلسل الحالات والمتتبّع
console.log('\n=== 6) تسلسل حالات الطلب والمتتبّع ===');
const order = ['pending', 'accepted', 'assigned', 'in-progress', 'completed'];
check('ترتيب الحالات الخمس موحّد في المتتبّع',
  new RegExp(`statusOrder\\s*=\\s*\\[\\s*${order.map(s => `'${s}'`).join("\\s*,\\s*")}\\s*\\]`).test(indexHtml));
check('مسار "في الطريق" يستخدم on_the_way_at', /on_the_way_at/.test(indexHtml) && /tech_on_the_way/.test(sql));

// ------------------------------------------------ 7) RLS والمشغّلات في SQL
console.log('\n=== 7) سياسات RLS والمشغّلات المطلوبة في SQL ===');
const requiredPolicies = [
  'users_select_isolated', 'orders_select_isolated', 'invoices_select_isolated',
  'technicians_select_own_or_admin', 'technicians_insert_admin', 'technicians_update_own_or_admin', 'technicians_delete_admin',
  'notifications_select_own', 'push_subs_select_own',
];
for (const p of requiredPolicies) check(`سياسة RLS موجودة: ${p}`, new RegExp(`create policy ${p}\\b`, 'i').test(sql));
const requiredTriggers = [
  'trg_prevent_tech_order_tamper', 'trg_prevent_tech_invoice_tamper',
  'trg_prevent_tech_self_update_overreach', 'trg_freeze_invoice_barcode',
  'trg_validate_order_status_transition', 'trg_fanout_tech_notification',
];
for (const t of requiredTriggers) check(`مشغّل موجود: ${t}`, new RegExp(t, 'i').test(sql));
check('لا سياسة USING(true) على جدول حساس',
  !/create policy [a-z_]*\s+on public\.(users|orders|invoices|technicians)\b[\s\S]{0,120}?using\s*\(\s*true\s*\)/i.test(sql));
check('عرض technicians_public موجود', /create (or replace )?view public\.technicians_public/i.test(sql), 'تحقق من الاسم');

// ---------------------------------------------------------------- النتيجة
console.log('\n================ النتيجة النهائية ================');
console.log(`  ✅ ناجح: ${pass}`);
console.log(`  ❌ فاشل: ${fail}`);
if (fail) {
  console.log('\n  الفحوصات الفاشلة:');
  results.filter(r => !r.ok).forEach(r => console.log(`   - ${r.name} ${r.detail ? '(' + r.detail + ')' : ''}`));
}
process.exit(fail ? 1 : 0);
