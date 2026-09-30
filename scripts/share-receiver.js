(function () {
  'use strict';

  const BUCKET = 'payment-receipts';
  const SUPABASE_PROJECT = 'pullcihxwmcoxqmzldqi';
  const TUS_ENDPOINT = 'https://' + SUPABASE_PROJECT + '.storage.supabase.co/storage/v1/upload/resumable';
  let sharedHandled = false;
  let modalOpen = false;

  function plugin() {
    return window.Capacitor?.Plugins?.ShareReceiver || null;
  }

  function toast(message, type) {
    try {
      if (typeof window.showAlert === 'function') return window.showAlert(message, type || 'info', 5000);
    } catch (_) {}
    alert(message);
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }

  function ensureModal() {
    if (document.getElementById('obied-share-payment-modal')) return;
    const style = document.createElement('style');
    style.id = 'obied-share-payment-style';
    style.textContent = `
      #obied-share-payment-modal{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.65);display:none;align-items:center;justify-content:center;padding:18px}
      #obied-share-payment-modal.show{display:flex}
      #obied-share-payment-box{width:min(520px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:20px;padding:18px;box-shadow:0 25px 80px rgba(0,0,0,.28);font-family:inherit}
      #obied-share-payment-box h3{margin:0 0 8px;color:#1e3a8a;font-size:1.15rem}
      #obied-share-payment-box .obied-file{background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:10px;margin:10px 0 14px;font-size:.88rem}
      .obied-invoice-choice{width:100%;text-align:right;border:1px solid #e2e8f0;background:#fff;border-radius:14px;padding:12px;margin:7px 0;cursor:pointer;font-family:inherit}
      .obied-invoice-choice:hover{background:#f8fafc;border-color:#3b82f6}
      .obied-invoice-choice strong{display:block;color:#1e40af}.obied-invoice-choice span{display:block;color:#64748b;font-size:.82rem;margin-top:3px}
      #obied-share-progress{height:8px;background:#e2e8f0;border-radius:8px;overflow:hidden;margin:12px 0;display:none}
      #obied-share-progress i{display:block;height:100%;width:0;background:#2563eb;transition:width .2s}
      .obied-share-actions{display:flex;gap:8px;margin-top:12px}.obied-share-actions button{flex:1;border:0;border-radius:12px;padding:11px;font-family:inherit;font-weight:800;cursor:pointer}
      #obied-share-close{background:#e2e8f0}.obied-share-send{background:#2563eb;color:#fff}
      body.dark-mode #obied-share-payment-box{background:#111827;color:#f1f5f9}.dark-mode .obied-invoice-choice{background:#1f2937;color:#f1f5f9;border-color:#374151}
    `;
    document.head.appendChild(style);
    const modal = document.createElement('div');
    modal.id = 'obied-share-payment-modal';
    modal.innerHTML = `
      <div id="obied-share-payment-box" dir="rtl">
        <h3>📄 إثبات الدفع المستلم</h3>
        <div id="obied-share-file" class="obied-file"></div>
        <div id="obied-share-invoices"><div style="text-align:center;color:#64748b">جاري تحميل الفواتير...</div></div>
        <div id="obied-share-progress"><i></i></div>
        <div class="obied-share-actions"><button id="obied-share-close">إلغاء</button></div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('obied-share-close').onclick = () => closeModal();
  }

  function closeModal() {
    const m = document.getElementById('obied-share-payment-modal');
    if (m) m.classList.remove('show');
    modalOpen = false;
  }

  function formatMoney(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('ar-SY') : String(v ?? '');
  }

  async function loadInvoices(fileInfo) {
    ensureModal();
    const list = document.getElementById('obied-share-invoices');
    const { data: authData } = await sb.auth.getUser();
    if (!authData?.user) {
      list.innerHTML = '<div style="color:#b91c1c">يجب تسجيل الدخول أولاً.</div>';
      return;
    }
    const { data, error } = await sb.from('invoices')
      .select('id,invoice_number,total,status,receipt_status,created_at,service')
      .in('status', ['pending_payment','awaiting_payment','overdue','pending_verification'])
      .order('created_at', { ascending: false });

    if (error) {
      list.innerHTML = '<div style="color:#b91c1c">تعذر تحميل الفواتير: ' + esc(error.message) + '</div>';
      return;
    }
    if (!data?.length) {
      list.innerHTML = '<div style="color:#64748b;text-align:center;padding:15px">لا توجد فواتير بانتظار الدفع.</div>';
      return;
    }
    list.innerHTML = data.map(inv => `
      <button class="obied-invoice-choice" data-invoice-id="${esc(inv.id)}">
        <strong>فاتورة #${esc(inv.invoice_number || inv.id)}</strong>
        <span>${esc(inv.service || 'خدمة صيانة')} — ${formatMoney(inv.total)} ل.س — ${esc(inv.status || '')}</span>
      </button>`).join('');

    list.querySelectorAll('.obied-invoice-choice').forEach(btn => {
      btn.addEventListener('click', () => submitProof(data.find(x => String(x.id) === String(btn.dataset.invoiceId)), fileInfo));
    });
  }

  async function ensureTus() {
    if (window.tus) return true;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tus-js-client@4.3.1/dist/tus.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('تعذر تحميل مكوّن رفع الملفات'));
      document.head.appendChild(s);
    });
    return !!window.tus;
  }

  async function submitProof(invoice, fileInfo) {
    if (!invoice || !fileInfo?.uri) return;
    if (modalOpen === false) return;
    const buttons = [...document.querySelectorAll('.obied-invoice-choice')];
    buttons.forEach(b => b.disabled = true);

    const progress = document.getElementById('obied-share-progress');
    const bar = progress.querySelector('i');
    progress.style.display = 'block';
    bar.style.width = '1%';

    try {
      const { data: authData } = await sb.auth.getUser();
      if (!authData?.user) throw new Error('انتهت جلسة تسجيل الدخول');
      const { data: profile, error: pErr } = await sb.from('users').select('id').eq('auth_uid', authData.user.id).single();
      if (pErr || !profile?.id) throw new Error('تعذر تحديد حساب المستخدم');

      const nativePath = window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(fileInfo.uri) : fileInfo.uri;
      const response = await fetch(nativePath);
      if (!response.ok) throw new Error('تعذر قراءة الملف المستلم');
      const fileBlob = await response.blob();
      const ext = (fileInfo.fileName || '').toLowerCase().endsWith('.pdf') ? 'pdf' :
                  (fileInfo.mimeType || '').includes('png') ? 'png' :
                  (fileInfo.mimeType || '').includes('webp') ? 'webp' : 'jpg';
      const objectPath = String(profile.id) + '/' + String(invoice.id) + '/' + Date.now() + '.' + ext;

      await ensureTus();
      const { data: sessionData } = await sb.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error('تعذر الحصول على جلسة رفع آمنة');

      await new Promise((resolve, reject) => {
        const upload = new tus.Upload(fileBlob, {
          endpoint: TUS_ENDPOINT,
          retryDelays: [0, 3000, 5000, 10000, 20000],
          headers: { authorization: 'Bearer ' + token, 'x-upsert': 'true' },
          metadata: {
            bucketName: BUCKET,
            objectName: objectPath,
            contentType: fileInfo.mimeType || 'application/octet-stream',
            cacheControl: '3600'
          },
          chunkSize: 6 * 1024 * 1024,
          uploadDataDuringCreation: true,
          onError: err => reject(err),
          onProgress: (uploaded, total) => {
            const pct = total ? Math.min(99, Math.round(uploaded / total * 100)) : 1;
            bar.style.width = pct + '%';
          },
          onSuccess: resolve
        });
        upload.start();
      });

      const publicUrl = 'https://' + SUPABASE_PROJECT + '.supabase.co/storage/v1/object/public/' +
        BUCKET + '/' + objectPath.split('/').map(encodeURIComponent).join('/');

      const { error: updateError } = await sb.from('invoices').update({
        receipt_image: publicUrl,
        receipt_status: 'pending_verification',
        status: 'pending_verification'
      }).eq('id', invoice.id);

      if (updateError) throw updateError;

      bar.style.width = '100%';
      toast('تم إرسال إثبات الدفع وربطه بالفاتورة #' + (invoice.invoice_number || invoice.id), 'success');
      sharedHandled = true;
      try { await plugin()?.deleteSharedFile({ uri: fileInfo.uri }); } catch (_) {}
      setTimeout(closeModal, 500);
    } catch (err) {
      buttons.forEach(b => b.disabled = false);
      progress.style.display = 'none';
      bar.style.width = '0';
      toast('تعذر إرسال إثبات الدفع: ' + (err?.message || err), 'error');
    }
  }

  async function pollSharedFile() {
    const p = plugin();
    if (!p || sharedHandled) return;
    try {
      const result = await p.getSharedFile();
      if (!result?.available || !result.uri) return;
      sharedHandled = true;
      ensureModal();
      modalOpen = true;
      document.getElementById('obied-share-payment-modal').classList.add('show');
      document.getElementById('obied-share-file').innerHTML =
        '<strong>الملف:</strong> ' + esc(result.fileName) + '<br><strong>النوع:</strong> ' +
        esc(result.mimeType) + '<br><strong>الحجم:</strong> ' + formatBytes(result.size);
      await loadInvoices(result);
    } catch (err) {
      console.error('ShareReceiver:', err);
    }
  }

  function formatBytes(bytes) {
    let n = Number(bytes || 0);
    if (!n) return 'غير معروف';
    const units = ['B','KB','MB','GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 2 : 0) + ' ' + units[i];
  }

  function start() {
    ensureModal();
    setInterval(pollSharedFile, 1500);
    setTimeout(pollSharedFile, 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
