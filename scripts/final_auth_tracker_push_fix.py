from pathlib import Path

p = Path("index.html")
s = p.read_text(encoding="utf-8")

# 1) Registration: never report a false failure after Supabase Auth already created the account.
old = """      } catch(err) {
        showAlert('خطأ في إنشاء الحساب: ' + (err.message||'تعذر إنشاء الحساب'), 'error', 6000);
      } finally {"""
new = """      } catch(err) {
        // إذا تم إنشاء Auth بالفعل، أكمل تسجيل الدخول/الملف الشخصي بدل إظهار
        // خطأ يجعل المستخدم يضغط مرة ثانية ثم يرى "الحساب موجود".
        try {
          const { data: recoveryAuth } = await sb.auth.getUser();
          const au = recoveryAuth?.user;
          if (au?.id) {
            let { data: recoveredProfile } = await sb.from('users')
              .select('id,name,email,phone,profile_image,role,auth_uid')
              .eq('auth_uid', au.id).maybeSingle();
            if (!recoveredProfile) {
              const { data: ensured } = await sb.rpc('create_my_user_profile', {
                p_name: name, p_email: email, p_phone: phone || ''
              });
              recoveredProfile = ensured;
            } else if (phone) {
              const { data: updatedProfile } = await sb.from('users')
                .update({ name: name || recoveredProfile.name, phone })
                .eq('id', recoveredProfile.id)
                .select('id,name,email,phone,profile_image,role,auth_uid')
                .single();
              if (updatedProfile) recoveredProfile = updatedProfile;
            }
            if (recoveredProfile?.id) {
              await applyRoleAndRoute(recoveredProfile, await resolveUserRole(recoveredProfile), { isNewAccount: true });
              showAlert('✅ تم إنشاء حسابك وتسجيل دخولك بنجاح', 'success', 5000);
              return;
            }
          }
        } catch(recoveryErr) {
          console.error('registration recovery:', recoveryErr);
        }
        showAlert('خطأ في إنشاء الحساب: ' + (err.message||'تعذر إنشاء الحساب'), 'error', 6000);
      } finally {"""
if old in s:
    s = s.replace(old, new, 1)
elif "registration recovery:" not in s:
    raise SystemExit("registration catch block not found and recovery patch is absent")

# 2) Customer tracker: map post-service payment states to the completed stage.
old = """  const trackingStatus = (hasTech && active.status === 'accepted') ? 'assigned' : active.status;
  const rawIdx = statusOrder.indexOf(trackingStatus);"""
new = """  let trackingStatus = (hasTech && active.status === 'accepted') ? 'assigned' : active.status;
  if (['awaiting_payment','pending_verification','paid'].includes(trackingStatus)) trackingStatus = 'completed';
  const rawIdx = statusOrder.indexOf(trackingStatus);"""
if old not in s:
    raise SystemExit("customer tracking mapping not found")
s = s.replace(old, new, 1)

# 3) Native push: expose an explicit initializer and make it safe to call after login.
old = """  function initNativePush() {
    if (!isNative()) return;"""
new = """  function initNativePush() {
    if (window._nativePushInitialized) return;
    if (!isNative()) return;
    window._nativePushInitialized = true;"""
if old not in s:
    raise SystemExit("native push initializer not found")
s = s.replace(old, new, 1)

old = """  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(initNativePush, 300);
  });"""
new = """  window.enableNativePush = initNativePush;
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(initNativePush, 300);
  });"""
if old not in s:
    raise SystemExit("native push DOM initializer not found")
s = s.replace(old, new, 1)

# 4) After authentication, explicitly initialize native push again (idempotent)
# so Android permission/token registration is tied to a real logged-in account.
old = """  updateUIForLoggedInUser();
  updateBookingForm();
  if (typeof syncPushToken === 'function') syncPushToken();"""
new = """  updateUIForLoggedInUser();
  updateBookingForm();
  if (typeof enableNativePush === 'function') enableNativePush();
  if (typeof syncPushToken === 'function') setTimeout(() => syncPushToken(), 250);"""
if old not in s:
    raise SystemExit("applyRoleAndRoute push hook not found")
s = s.replace(old, new, 1)

p.write_text(s, encoding="utf-8")
print("final auth/tracker/push patch applied")
