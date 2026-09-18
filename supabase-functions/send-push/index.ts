// supabase/functions/send-push/index.ts
//
// دالة سيرفرلس (Edge Function) تُرسل إشعار Push حقيقي لأجهزة أندرويد و iOS
// عبر Firebase Cloud Messaging (FCM HTTP v1 API).
//
// كيف تُستدعى:
// تلقائياً عبر "Database Webhook" في Supabase على جدول notifications
// (عند INSERT جديد) — راجع ملف supabase-functions/README.md لخطوات الربط.
//
// المتغيرات البيئية المطلوبة (تُضبط عبر: npx supabase secrets set):
//   FCM_PROJECT_ID          -> Project ID من Firebase
//   FCM_SERVICE_ACCOUNT_JSON -> محتوى ملف service-account.json كاملاً (نص JSON بسطر واحد)
//   SUPABASE_URL             -> (موجود تلقائياً)
//   SUPABASE_SERVICE_ROLE_KEY -> (موجود تلقائياً)

import { createClient } from "npm:@supabase/supabase-js@2";
import { GoogleAuth } from "npm:google-auth-library@9";

const FCM_PROJECT_ID = Deno.env.get("FCM_PROJECT_ID")!;
const SERVICE_ACCOUNT_JSON = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function getAccessToken(): Promise<string> {
  const credentials = JSON.parse(SERVICE_ACCOUNT_JSON);
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token as string;
}

async function sendToToken(accessToken: string, token: string, title: string, body: string, data: Record<string, string>) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data,
          android: {
            priority: "high",
            notification: { channel_id: "obied_default", sound: "default" },
          },
          apns: { headers: { "apns-priority": "10" } },
        },
      }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    console.error("FCM send failed for token", token, errText);
    // إذا كان التوكن غير صالح (تطبيق محذوف)، احذفه من القاعدة
    if (res.status === 404 || res.status === 400) {
      await supabase.from("push_subscriptions").delete().eq("device_token", token);
    }
  }
  return res.ok;
}

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json();

    // شكل الطلب المتوقع من Database Webhook: { record: { user_id, message, type } }
    // أو استدعاء يدوي مباشر: { user_id, title, body, data }
    const record = payload.record || payload;
    const userId = record.user_id;
    const title = record.title || "عبيد للصيانة";
    const body = record.body || record.message || "لديك تحديث جديد";
    const type = record.type || "general";
    const relatedId = record.related_id ?? record.relatedId ?? record.id ?? "";
    const invoiceId = record.invoice_id ?? record.invoiceId ?? "";

    if (!userId) {
      return new Response(JSON.stringify({ ok: false, error: "user_id missing" }), { status: 400 });
    }

    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("device_token")
      .eq("user_id", userId);

    if (error) throw error;
    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, note: "no device tokens for user" }), { status: 200 });
    }

    const accessToken = await getAccessToken();
    const results = await Promise.all(
      subs.map((s) => sendToToken(accessToken, s.device_token, title, body, {
        type: String(type),
        related_id: String(relatedId),
        invoice_id: String(invoiceId)
      }))
    );

    return new Response(
      JSON.stringify({ ok: true, sent: results.filter(Boolean).length, total: subs.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});
