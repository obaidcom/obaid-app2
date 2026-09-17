from pathlib import Path
import re

p = Path('index.html')
s = p.read_text(encoding='utf-8')
original = s

# Customer booking must use the safe public technician view.
s = s.replace(
    "sb.from('technicians')\n        .select('id,name').eq('is_active', true).eq('governorate', booking.governorate).limit(5)",
    "sb.from('technicians_public')\n        .select('id,name').eq('is_active', true).eq('governorate', booking.governorate).limit(5)",
    1,
)

# Technician-role accounts create/find their row through the secured RPC.
pattern = re.compile(
    r"if \(!techData\) \{\s*"
    r"// أنشئ سجل فني افتراضي تلقائياً إذا تم منح الدور دون ملف فني مسبق.*?"
    r"\n\s*techData = created;\s*\n\s*\}",
    re.S,
)
replacement = """if (!techData) {
        // إنشاء/استرجاع سجل الفني عبر RPC آمن يعتمد على auth.uid()
        const { data: ensuredTech, error: ensureErr } = await sb.rpc('ensure_my_technician_row', {
          p_name: userRow.name || 'فني',
          p_phone: userRow.phone || ''
        });
        if (!ensureErr && ensuredTech) techData = ensuredTech;
      }"""
s, n = pattern.subn(replacement, s, count=1)
if n != 1:
    raise SystemExit('technician-row creation block not found')

# The old technician code/master-code login cannot create a Supabase Auth session.
login_pattern = re.compile(
    r"function showTechLogin\(\) \{.*?\n\}\n\n"
    r"async function loginTech\(\) \{.*?\n\}\n\n"
    r"function showTechDashboard",
    re.S,
)
login_replacement = """function showTechLogin() {
  showLoginPage();
  switchLoginTab('login');
  showAlert('👷 سجّل دخول الفني باستخدام البريد الإلكتروني وكلمة المرور المرتبطين بحسابك', 'info', 5000);
}

async function loginTech() {
  showLoginPage();
  switchLoginTab('login');
  showAlert('👷 تم تحويلك إلى تسجيل الدخول الآمن للفني', 'info', 3500);
}

function showTechDashboard"""
s, n = login_pattern.subn(login_replacement, s, count=1)
if n != 1:
    raise SystemExit('legacy technician login block not found')

# Do not trust localStorage as authentication for the technician dashboard.
old_guard = """function showTechDashboard() {
  // تحقق من تسجيل دخول الفني
  const saved = localStorage.getItem('obied_tech');
  if (!currentTechnician && saved) currentTechnician = JSON.parse(saved);
  if (!currentTechnician) { showTechLogin(); return; }
"""
new_guard = """async function showTechDashboard() {
  // لا تعتمد على localStorage كمصدر مصادقة. يجب وجود جلسة Supabase Auth حقيقية.
  const { data: sessionData } = await sb.auth.getSession();
  const session = sessionData?.session;
  if (!session?.user) {
    currentTechnician = null;
    localStorage.removeItem('obied_tech');
    showTechLogin();
    return;
  }

  const { data: userRow } = await sb.from('users')
    .select('id,name,email,phone,role')
    .eq('auth_uid', session.user.id)
    .maybeSingle();
  if (!userRow || userRow.role !== 'technician') {
    currentTechnician = null;
    localStorage.removeItem('obied_tech');
    showAlert('هذا الحساب ليس حساب فني', 'error');
    showHome();
    return;
  }

  let { data: techRow } = await sb.from('technicians')
    .select('*').eq('user_ref_id', userRow.id).eq('is_active', true).maybeSingle();
  if (!techRow) {
    const { data: ensuredTech, error: ensureErr } = await sb.rpc('ensure_my_technician_row', {
      p_name: userRow.name || 'فني',
      p_phone: userRow.phone || ''
    });
    if (ensureErr) {
      showAlert('تعذر تجهيز ملف الفني: ' + ensureErr.message, 'error', 6000);
      return;
    }
    techRow = ensuredTech;
  }
  if (!techRow) {
    showAlert('لم يتم العثور على ملف الفني', 'error');
    return;
  }

  currentUser = { id: userRow.id, name: userRow.name, email: userRow.email, phone: userRow.phone, role: 'technician' };
  currentTechnician = {
    ...techRow,
    permissions: { viewOrders:true, updateStatus:true, viewCustomer:false, allGovernorates:false, ...(techRow.permissions || {}) },
    loginTime: new Date().toISOString()
  };
  localStorage.setItem('obied_current_user', JSON.stringify(currentUser));
  localStorage.setItem('obied_tech', JSON.stringify(currentTechnician));
"""
if old_guard not in s:
    raise SystemExit('technician dashboard auth guard not found')
s = s.replace(old_guard, new_guard, 1)

if s == original:
    raise SystemExit('no index changes made')

# Basic postconditions.
for marker in (
    "sb.from('technicians_public')",
    "ensure_my_technician_row",
    "sb.auth.getSession()",
):
    if marker not in s:
        raise SystemExit(f'missing postcondition: {marker}')

p.write_text(s, encoding='utf-8')
print('index.html repair applied')
