// supabase/functions/migrate-legacy-users/index.ts
// ============================================================================
//  عبيد للصيانة — دالة سيرفرلس لترحيل الحسابات القديمة إلى Supabase Auth
// ============================================================================
//  ماذا تفعل؟
//    تستقبل طلباً من index.html بعد أن يكون المستخدم قد أنشأ/سجّل دخوله
//    بحساب Supabase Auth جديد بنفس البريد القديم، ثم:
//      1) تتحقق أن التوكن المرسل توكن حقيقي لجلسة Supabase Auth.
//      2) تتأكد أن بريد الجلسة = البريد المطلوب ترحيله (لا يمكن ترحيل حساب
//         شخص آخر مهما كان جسم الطلب).
//      3) تتحقق من كلمة المرور القديمة عبر public.legacy_verify_password
//         (دالة service_role فقط — لا يستطيع أي عميل تنفيذها).
//      4) تربط الصف القديم بالحساب الجديد وتمسح pass_word نهائياً عبر
//         public.legacy_mark_migrated، مع منع ازدواج الحسابات.
//      5) تسجّل كل محاولة (نجاح/فشل) في legacy_migration_attempts.
//
//  الأمان:
//    - لا تُعيد مفتاح service_role ولا أي سر لأي عميل، ولا تظهره في أي رسالة.
//    - لا تُنشئ حسابات Auth (الإنشاء يتم في التطبيق عبر signUp / signIn).
//    - لا تُغيّر كلمة المرور الجديدة إطلاقاً — هي مملوكة للمستخدم في Auth.
//    - رسائل الفشل عامة للمستخدم، والتفاصيل تُسجَّل داخلياً فقط.
//    - حدّ للمحاولات: 5 محاولات فاشلة لكل بريد خلال 15 دقيقة.
//
//  المتغيرات البيئية (تُضبط تلقائياً في Supabase — لا تكتبها في index.html):
//    SUPABASE_URL               (تلقائي)
//    SUPABASE_ANON_KEY          (تلقائي)
//    SUPABASE_SERVICE_ROLE_KEY  (تلقائي — يُستخدم داخل الدالة فقط)
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function fail(code: string, status = 200): Response {
  // رسالة عامة للمستخدم — التفاصيل تُسجّل داخلياً فقط
  return json({ ok: false, error: code }, status);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return fail("method_not_allowed", 405);

  let email = "";
  let oldPassword = "";
  let name: string | null = null;
  let phone: string | null = null;

  try {
    const body = await req.json();
    email = String(body?.email ?? "").trim().toLowerCase();
    oldPassword = String(body?.old_password ?? "");
    name = body?.name ? String(body.name).slice(0, 120) : null;
    phone = body?.phone ? String(body.phone).slice(0, 30) : null;
  } catch {
    return fail("invalid_request", 400);
  }

  if (!email || !oldPassword) return fail("invalid_request", 400);
  if (email.length > 200 || oldPassword.length > 200) return fail("invalid_request", 400);

  // ---- 1) التحقق من توكن الجلسة الحقيقي ----
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return fail("unauthorized", 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  const sessionUser = userData?.user;
  if (userError || !sessionUser?.id || !sessionUser.email) return fail("unauthorized", 401);

  // ---- 2) لا يمكن ترحيل حساب شخص آخر: بريد الجلسة يجب أن يطابق الطلب ----
  if (sessionUser.email.trim().toLowerCase() !== email) {
    return fail("email_mismatch", 403);
  }

  const authUid = sessionUser.id;
  const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- 3) حدّ المحاولات (حماية من تخمين كلمة المرور القديمة) ----
  try {
    const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
    const { count } = await service
      .from("legacy_migration_attempts")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .eq("success", false)
      .gte("created_at", since);
    if ((count ?? 0) >= MAX_FAILURES) return fail("too_many_attempts", 429);
  } catch (e) {
    console.error("rate-limit check failed", e);
  }

  // ---- 4) التحقق من كلمة المرور القديمة (service_role فقط) ----
  let verify: Record<string, unknown> = {};
  try {
    const { data, error } = await service.rpc("legacy_verify_password", {
      p_email: email,
      p_password: oldPassword,
    });
    if (error) throw error;
    verify = (data ?? {}) as Record<string, unknown>;
  } catch (e) {
    console.error("legacy_verify_password failed", e);
    await service.rpc("legacy_log_attempt", { p_email: email, p_success: false, p_reason: "verify_error" });
    return fail("server_error", 500);
  }

  if (verify.ok !== true) {
    const reason = String(verify.reason ?? "invalid_credentials");
    await service.rpc("legacy_log_attempt", { p_email: email, p_success: false, p_reason: reason });
    if (reason === "already_migrated") return fail("already_migrated");
    if (reason === "invalid_request") return fail("invalid_request", 400);
    return fail("invalid_credentials");
  }

  // ---- 5) الربط الآمن + مسح كلمة المرور القديمة (لا حسابات مكررة) ----
  try {
    const { data, error } = await service.rpc("legacy_mark_migrated", {
      p_email: email,
      p_auth_uid: authUid,
      p_name: name ?? (verify.name ? String(verify.name) : null),
      p_phone: phone ?? (verify.phone ? String(verify.phone) : null),
    });
    if (error) {
      const msg = String(error.message ?? "");
      if (msg.includes("ALREADY_MIGRATED")) return fail("already_migrated");
      throw error;
    }

    const row = (data ?? {}) as Record<string, unknown>;
    // لا نُعيد أي بيانات حساسة — فقط ما يحتاجه التطبيق لعرض "اكتمل الترحيل"
    return json({
      ok: true,
      migrated: true,
      user: {
        id: row.id ?? null,
        name: row.name ?? null,
        email: row.email ?? null,
        role: row.role ?? "user",
      },
    });
  } catch (e) {
    console.error("legacy_mark_migrated failed", e);
    await service.rpc("legacy_log_attempt", { p_email: email, p_success: false, p_reason: "link_error" });
    return fail("server_error", 500);
  }
});

// ============================================================================
//  نشر الدالة:
//    npx supabase functions deploy migrate-legacy-users
//  (لا تحتاج أي أسرار إضافية — SUPABASE_* مضبوطة تلقائياً في Supabase)
//
//  مثال استدعاء من التطبيق (index.html):
//    await sb.functions.invoke('migrate-legacy-users', {
//      body: { email, old_password, name, phone },
//      headers: { Authorization: `Bearer ${session.access_token}` }
//    });
// ============================================================================
