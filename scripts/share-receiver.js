(function(){
'use strict';
const BUCKET='payment-receipts', PROJECT='pullcihxwmcoxqmzldqi';
const ENDPOINT='https://'+PROJECT+'.storage.supabase.co/storage/v1/upload/resumable';
let handled=false, fileInfo=null;
function plugin(){return window.Capacitor?.Plugins?.ShareReceiver||null}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function msg(t,type){try{if(window.showAlert)return window.showAlert(t,type||'info',6000)}catch(e){} alert(t)}
function ui(){
 if(document.getElementById('obied-share-modal'))return;
 const s=document.createElement('style');s.textContent='#obied-share-modal{position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.65);display:none;align-items:center;justify-content:center;padding:16px}#obied-share-modal.show{display:flex}#obied-share-box{width:min(520px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:20px;padding:18px;font-family:inherit;direction:rtl}.obied-si{width:100%;text-align:right;border:1px solid #ddd;background:#fff;border-radius:12px;padding:12px;margin:6px 0;font-family:inherit}.obied-si strong{display:block;color:#1e40af}.obied-si span{display:block;color:#64748b;font-size:.85rem;margin-top:3px}.obied-share-bar{height:7px;background:#e5e7eb;border-radius:8px;overflow:hidden;display:none;margin:10px 0}.obied-share-bar i{display:block;height:100%;width:0;background:#2563eb}';document.head.appendChild(s);
 const d=document.createElement('div');d.id='obied-share-modal';d.innerHTML='<div id="obied-share-box"><h3>📄 إثبات الدفع المستلم</h3><div id="obied-share-file"></div><div id="obied-share-list">جاري تحميل الفواتير...</div><div class="obied-share-bar" id="obied-share-bar"><i></i></div><button id="obied-share-close" style="width:100%;margin-top:10px;padding:11px;border:0;border-radius:12px">إلغاء</button></div>';document.body.appendChild(d);
 document.getElementById('obied-share-close').onclick=()=>d.classList.remove('show');
}
async function user(){return (await window.sb?.auth?.getUser())?.data?.user||null}
async function invoices(){
 const u=await user(); if(!u)throw Error('يجب تسجيل الدخول أولاً');
 const p=await sb.from('users').select('id').eq('auth_uid',u.id).single(); if(p.error)throw p.error;
 const r=await sb.from('invoices').select('id,invoice_number,service,total,status,created_at').eq('customer_id',p.data.id).in('status',['pending_payment','awaiting_payment','overdue','pending_verification']).order('created_at',{ascending:false});
 if(r.error)throw r.error; return r.data||[];
}
function tus(){if(window.tus)return Promise.resolve();return new Promise((ok,no)=>{let x=document.createElement('script');x.src='https://cdn.jsdelivr.net/npm/tus-js-client@4.3.1/dist/tus.min.js';x.onload=ok;x.onerror=()=>no(Error('تعذر تحميل رفع الملفات'));document.head.appendChild(x)})}
async function send(inv){
 const p=plugin();if(!p||!fileInfo)return; const bar=document.getElementById('obied-share-bar'),i=bar.querySelector('i');bar.style.display='block';
 try{
  const u=await user();if(!u)throw Error('انتهت جلسة الدخول');
  const pr=await sb.from('users').select('id').eq('auth_uid',u.id).single();if(pr.error)throw pr.error;
  const url=window.Capacitor.convertFileSrc(fileInfo.uri),res=await fetch(url);if(!res.ok)throw Error('تعذر قراءة الملف');
  const blob=await res.blob(),n=(fileInfo.fileName||'').toLowerCase();let ext=fileInfo.mimeType==='application/pdf'||n.endsWith('.pdf')?'pdf':fileInfo.mimeType==='image/png'||n.endsWith('.png')?'png':fileInfo.mimeType==='image/webp'||n.endsWith('.webp')?'webp':'jpg';
  const path=pr.data.id+'/'+inv.id+'/'+Date.now()+'.'+ext;await tus();const ss=await sb.auth.getSession(),token=ss?.data?.session?.access_token;if(!token)throw Error('لا توجد جلسة آمنة');
  await new Promise((ok,no)=>{let up=new tus.Upload(blob,{endpoint:ENDPOINT,retryDelays:[0,3000,5000,10000,20000],headers:{authorization:'Bearer '+token,'x-upsert':'true'},metadata:{bucketName:BUCKET,objectName:path,contentType:fileInfo.mimeType||'application/octet-stream',cacheControl:'3600'},chunkSize:6*1024*1024,onProgress:(a,b)=>i.style.width=(b?Math.round(a/b*100):1)+'%',onError:no,onSuccess:ok});up.start()});
  const publicUrl='https://'+PROJECT+'.supabase.co/storage/v1/object/public/'+BUCKET+'/'+path.split('/').map(encodeURIComponent).join('/');
  const up=await sb.from('invoices').update({receipt_image:publicUrl,receipt_status:'pending_verification',status:'pending_verification'}).eq('id',inv.id).eq('customer_id',pr.data.id);
  if(up.error)throw up.error;i.style.width='100%';msg('تم إرسال إثبات الدفع وربطه بالفاتورة #'+(inv.invoice_number||inv.id),'success');try{await p.deleteSharedFile({uri:fileInfo.uri})}catch(e){};document.getElementById('obied-share-modal').classList.remove('show');
 }catch(e){i.style.width='0';msg('تعذر إرسال إثبات الدفع: '+(e?.message||e),'error')}
}
async function poll(){
 if(handled)return;const p=plugin();if(!p)return;try{const r=await p.getSharedFile();if(!r?.available)return;handled=true;fileInfo=r;ui();document.getElementById('obied-share-modal').classList.add('show');document.getElementById('obied-share-file').innerHTML='<p><b>الملف:</b> '+esc(r.fileName)+'<br><b>النوع:</b> '+esc(r.mimeType)+'</p>';const list=document.getElementById('obied-share-list');const inv=await invoices();if(!inv.length){list.innerHTML='<p>لا توجد فواتير بانتظار الدفع.</p>';return}list.innerHTML=inv.map(x=>'<button class="obied-si" data-id="'+esc(x.id)+'"><strong>فاتورة #'+esc(x.invoice_number||x.id)+'</strong><span>'+esc(x.service||'خدمة')+' — '+esc(x.total)+' — '+esc(x.status)+'</span></button>').join('');list.querySelectorAll('.obied-si').forEach(b=>b.onclick=()=>send(inv.find(x=>String(x.id)===String(b.dataset.id))))}catch(e){console.error(e)}}
function start(){ui();setInterval(poll,1200);setTimeout(poll,800)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();