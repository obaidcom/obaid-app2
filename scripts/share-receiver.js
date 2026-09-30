(function () {
  'use strict';

  const BUCKET = 'payment-receipts';
  const PROJECT = 'pullcihxwmcoxqmzldqi';
  const TUS_ENDPOINT = 'https://' + PROJECT + '.storage.supabase.co/storage/v1/upload/resumable';
  let handled = false;
  let open = false;

  function getPlugin() {
    return window.Capacitor?.Plugins?.ShareReceiver || null;
  }

  function showMessage(message, type) {
    try {
      if (typeof window.showAlert === 'function') {
        window.showAlert(message, type || 'info', 5000);
        return;
      }
    } catch (_) {}
    alert(message);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]);
    });
  }

  function formatBytes(bytes) {
    let n = Number(bytes || 0);
    if (!n) return 'غير معروف';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 2 : 0) + ' ' + units[i];
  }

  function ensureUi() {
    if (document.getElementById('obied-share-payment-modal')) return;
    const style = document.createElement('style');
    style.textContent = '#obied-share-payment-modal{position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.65);display:none;align-items:center;justify-content:center;padding:18px}#obied-share-payment-modal.show{display:flex}#obied-share-payment-box{width:min(520px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:20px;padding:18px;box-shadow:0 25px 80px rgba(0,0,0,.28);font-family:inherit}#obied-share-payment-box h3{margin:0 0 8px;color:#1e3a8a}.obied-share-file{background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:10px;margin:10px 0 14px;font-size:.9rem}.obied-share-invoice{width:100%;text-align:right;border:1px solid #e2e8f0;background:#fff;border-radius:14px;padding:12px;margin:7px 0;cursor:pointer;font-family:inherit}.obied-share-invoice:disabled{opacity:.55}.obied-share-invoice strong{display:block;color:#1e40af}.obied-share-invoice span{display:block;color:#64748b;font-size:.82rem;margin-top:3px}.obied-share-actions{display:flex;gap:8px;margin-top:12px}.obied-share-actions button{flex:1;border:0;border-radius:12px;padding:11px;font-family:inherit;font-weight:800}.obied-share-cancel{background:#e2e8f0}.obied-share-progress{height:8px;background:#e2e8f0;border-radius:8px;overflow:hidden;margin:12px 0;display:none}.obied-share-progress i{display:block;height:100%;width:0;background:#2563eb;transition:width .2s}';
    document.head.appendChild(style);

    const modal = document.createElement('div');
    modal.id = 'obied-share-payment-modal';
    modal.dir = 'rtl';
    modal.innerHTML = '<div id="obied-share-payment-box"><h3>📄 إثبات الدفع المستلم</h3><div id="obied-share-file" class="obied-share-file"></div><div id="obied-share-invoices"><div style="text-align:center;color:#64748b">جاري تحميل الفواتير...</div></div><div class="obied-share-progress" id="obied-share-progress"><i></i></div><div class="obied-share-actions"><button class="obied-share-cancel" id="obied-share-close">إلغاء</button></div></div>';
    document.body.appendChild(modal);
    document.getElementById('obied-share-close').onclick = closeModal;
  }

  function closeModal() {
    const modal = document.getElementById('obied-share-payment-modal');
    if (modal) modal.classList.remove('show');
    open = false;
  }

  async function getCurrentUser() {
    if (!window.sb?.auth) return null;
    const result = await sb.auth.getUser();
    return result?.data?.user || null;
  }

  async function loadInvoices(fileInfo) {
    const list = document.getElementById('obied-share-invoices');
    try {
      const user = await getCurrentUser();
      if (!user) {
        list.innerHTML = '<div style="color:#b91c1c;text-align:center;padding:12px">يجب تسجيل الدخول أولاً.</div>';
        return;
      }

      const result = await sb.from('invoices')
        .select('id,invoice_number,total,status,receipt_status,created_at,service')
        .in('status', ['pending_payment','awaiting_payment','overdue','pending_verification'])
        .order('created_at', {ascending:false});

      if (result.error) throw result.error;
      const invoices = result.data || [];

      if (!invoices.length) {
        list.innerHTML = '<div style="color:#64748b;text-align:center;padding:15px">لا توجد فواتير بانتظار الدفع.</div>';
        return;
      }

      list.innerHTML = invoices.map(function (invoice) {
        return '<button type="button" class="obied-share-invoice" data-id="' + escapeHtml(invoice.id) + '">' +
          '<strong>فاتورة #' + escapeHtml(invoice.invoice_number || invoice.id) + '</strong>' +
          '<span>' + escapeHtml(invoice.service || 'خدمة صيانة') + ' — ' +
          escapeHtml(invoice.total) + ' — ' + escapeHtml(invoice.status || '') + '</span></button>';
      }).join('');

      list.querySelectorAll('.obied-share-invoice').forEach(function (button) {
        button.addEventListener('click', function () {
          const invoice = invoices.find(function (item) { return String(item.id) === String(button.dataset.id); });
          submitProof(invoice, fileInfo);
        });
      });
    } catch (error) {
      list.innerHTML = '<div style="color:#b91c1c;padding:12px">تعذر تحميل الفواتير: ' + escapeHtml(error?.message || error) + '</div>';
    }
  }

  function loadTus() {
    if (window.tus) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tus-js-client@4.3.1/dist/tus.min.js';
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('تعذر تحميل مكوّن رفع الملفات')); };
      document.head.appendChild(script);
    });
  }

  async function submitProof(invoice, fileInfo) {
    if (!invoice || !fileInfo?.uri || !open) return;

    const buttons = Array.from(document.querySelectorAll('.obied-share-invoice'));
    buttons.forEach(function (button) { button.disabled = true; });

    const progress = document.getElementById('obied-share-progress');
    const bar = progress.querySelector('i');
    progress.style.display = 'block';
    bar.style.width = '1%';

    try {
      const user = await getCurrentUser();
      if (!user) throw new Error('انتهت جلسة تسجيل الدخول');

      const profileResult = await sb.from('users').select('id').eq('auth_uid', user.id).single();
      if (profileResult.error || !profileResult.data?.id) throw new Error('تعذر تحديد حساب المستخدم');

      const nativeUri = window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(fileInfo.uri) : fileInfo.uri;
      const response = await fetch(nativeUri);
      if (!response.ok) throw new Error('تعذر قراءة الملف المستلم');
      const blob = await response.blob();

      const name = String(fileInfo.fileName || '').toLowerCase();
      let ext = 'jpg';
      if (fileInfo.mimeType === 'application/pdf' || name.endsWith('.pdf')) ext = 'pdf';
      else if (fileInfo.mimeType === 'image/png' || name.endsWith('.png')) ext = 'png';
      else if (fileInfo.mimeType === 'image/webp' || name.endsWith('.webp')) ext = 'webp';

      const objectPath = profileResult.data.id + '/' + invoice.id + '/' + Date.now() + '.' + ext;
      await loadTus();

      const session = await sb.auth.getSession();
      const token = session?.data?.session?.access_token;
      if (!token) throw new Error('تعذر الحصول على جلسة رفع آمنة');

      await new Promise(function (resolve, reject) {
        const upload = new window.tus.Upload(blob, {
          endpoint: TUS_ENDPOINT,
          retryDelays: [0, 3000, 5000, 10000, 20000],
          headers: {authorization: 'Bearer ' + token, 'x-upsert': 'true'},
          metadata: {
            bucketName: BUCKET,
            objectName: objectPath,
            contentType: fileInfo.mimeType || 'application/octet-stream',
            cacheControl: '3600'
          },
          chunkSize: 6 * 1024 * 1024,
          uploadDataDuringCreation: true,
          onError: reject,
          onProgress: function (uploaded, total) {
            bar.style.width = (total ? Math.min(99, Math.round(uploaded / total * 100)) : 1) + '%';
          },
          onSuccess: resolve
        });
        upload.start();
      });

      const publicUrl = 'https://' + PROJECT + '.supabase.co/storage/v1/object/public/' +
        BUCKET + '/' + objectPath.split('/').map(encodeURIComponent).join('/');

      const updateResult = await sb.from('invoices').update({
        receipt_image: publicUrl,
        receipt_status: 'pending_verification',
        status: 'pending_verification'
      }).eq('id', invoice.id);

      if (updateResult.error) throw updateResult.error;

      bar.style.width = '100%';
      showMessage('تم إرسال إثبات الدفع وربطه بالفاتورة #' + (invoice.invoice_number || invoice.id), 'success');
      handled = true;
      try { await getPlugin()?.deleteSharedFile({uri:fileInfo.uri}); } catch (_) {}
      setTimeout(closeModal, 500);
    } catch (error) {
      buttons.forEach(function (button) { button.disabled = false; });
      progress.style.display = 'none';
      bar.style.width = '0';
      showMessage('تعذر إرسال إثبات الدفع: ' + (error?.message || error), 'error');
    }
  }

  async function poll() {
    const plugin = getPlugin();
    if (!plugin || handled) return;

    try {
      const result = await plugin.getSharedFile();
      if (!result?.available || !result.uri) return;

      handled = true;
      ensureUi();
      open = true;
      document.getElementById('obied-share-payment-modal').classList.add('show');
      document.getElementById('obied-share-file').innerHTML =
        '<strong>الملف:</strong> ' + escapeHtml(result.fileName) +
        '<br><strong>النوع:</strong> ' + escapeHtml(result.mimeType) +
        '<br><strong>الحجم:</strong> ' + formatBytes(result.size);
      await loadInvoices(result);
    } catch (error) {
      console.error('ShareReceiver', error);
    }
  }

  function start() {
    ensureUi();
    setInterval(poll, 1200);
    setTimeout(poll, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
