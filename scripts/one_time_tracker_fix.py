from pathlib import Path
import re

p = Path('index.html')
s = p.read_text(encoding='utf-8')

old_status = "const statusOrder = ['pending','accepted','in-progress','completed'];\n  const rawIdx = statusOrder.indexOf(active.status);\n  const currentIdx = rawIdx === -1 ? 0 : rawIdx;\n  const hasTech = !!(active.tech_name || active.tech_id || active.accepted_by_tech);"
new_status = "const statusOrder = ['pending','accepted','assigned','in-progress','completed'];\n  const hasTech = !!(active.tech_name || active.tech_id || active.accepted_by_tech);\n  const trackingStatus = (hasTech && active.status === 'accepted') ? 'assigned' : active.status;\n  const rawIdx = statusOrder.indexOf(trackingStatus);\n  const currentIdx = rawIdx === -1 ? 0 : rawIdx;"
if old_status not in s:
    raise SystemExit('customer tracker status block not found')
s = s.replace(old_status, new_status, 1)

old_map = """        if (st.key === 'assigned') { done = false; active_ = hasTech; }
        else {
          const i = statusOrder.indexOf(st.key);
          done = i !== -1 && i < currentIdx;
          active_ = st.key === active.status;
        }"""
new_map = """        const i = statusOrder.indexOf(st.key);
        done = i !== -1 && i < currentIdx;
        active_ = st.key === trackingStatus;"""
if old_map not in s:
    raise SystemExit('customer tracker mapping block not found')
s = s.replace(old_map, new_map, 1)

mini_pattern = re.compile(r"function renderTechMiniTracker\(o\) \{.*?\n\}\n(?=\s*//|\s*function )", re.S)
mini_replacement = r'''function renderTechMiniTracker(o) {
  const hasTech = !!(o.tech_id || o.accepted_by_tech || o.tech_name);
  const trackingStatus = (hasTech && o.status === 'accepted') ? 'assigned' : o.status;
  const steps = [
    { key: 'pending',     label: 'تم استلام الطلب', icon: 'fa-inbox' },
    { key: 'accepted',    label: 'تم قبول الطلب',   icon: 'fa-thumbs-up' },
    { key: 'assigned',    label: 'تم تعيين فني',     icon: 'fa-hard-hat' },
    { key: 'in-progress', label: 'جاري المعالجة',    icon: 'fa-tools' },
    { key: 'completed',   label: 'تم الانتهاء',      icon: 'fa-check-circle' }
  ];
  const currentIdx = Math.max(0, steps.findIndex(s => s.key === trackingStatus));
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;background:#f8fafc;border-radius:12px;padding:12px 8px;margin-bottom:10px;">
    ${steps.map((s, i) => {
      const done = i < currentIdx;
      const active = i === currentIdx;
      return `<div style="flex:1;text-align:center;position:relative;">
        ${i>0 ? `<div style="position:absolute;top:14px;right:50%;width:100%;height:2px;background:${done || active ? '#10b981':'#e2e8f0'};z-index:0;"></div>` : ''}
        <div style="position:relative;z-index:1;margin:auto;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${done?'#10b981':active?'#2563eb':'#e2e8f0'};color:${done||active?'white':'#64748b'};"><i class="fas ${s.icon}"></i></div>
        <div style="font-size:0.68rem;margin-top:5px;color:${done||active?'#1f2937':'#94a3b8'};font-weight:${active?'800':'600'};line-height:1.3;">${s.label}</div>
      </div>`;
    }).join('')}
  </div>`;
}
'''
s, n = mini_pattern.subn(mini_replacement, s, count=1)
if n != 1:
    raise SystemExit('technician mini tracker function not found')

accept_pattern = re.compile(r"// ----- الفني: قبول طلب -----\nasync function techAcceptOrder\(orderId\) \{.*?\n\}\n\n// ===== الفني في الطريق", re.S)
accept_replacement = r'''// ----- الفني: قبول طلب -----
async function techAcceptOrder(orderId) {
  if (!currentTechnician?.id) { showAlert('يجب تسجيل الدخول كفني لقبول الطلبات', 'error'); return; }
  try {
    const { data: acceptedOrder, error } = await sb.rpc('accept_order', { p_order_id: orderId });
    if (error) throw error;
    if (!acceptedOrder) { showAlert('تعذر قبول الطلب أو تم قبوله من فني آخر', 'warning'); loadTechOrders(); return; }

    const idx = allOrders.findIndex(o => String(o.id) === String(orderId));
    if (idx !== -1) allOrders[idx] = { ...allOrders[idx], ...acceptedOrder };
    renderTechOrders();

    if (acceptedOrder.user_id) {
      sb.from('notifications').insert([{
        user_id: acceptedOrder.user_id,
        message: '✅ تم قبول طلبك (' + (acceptedOrder.service||'') + ') وسيبدأ الفني معالجة الطلب قريباً',
        type: 'order_update', related_id: acceptedOrder.id, is_read: false
      }]).catch(()=>{});
    }
    showAlert('✅ تم قبول الطلب — تم تعيين الفني. اضغط «بدء المعالجة» عند البدء.', 'success', 5000);
  } catch (e) {
    showAlert('خطأ في قبول الطلب: ' + (e.message || e), 'error');
    loadTechOrders();
  }
}

// ===== الفني: بدء المعالجة =====
async function techStartProcessing(orderId) {
  if (!currentTechnician?.id) return;
  try {
    const now = new Date().toISOString();
    const { data, error } = await sb.from('orders')
      .update({ status: 'in-progress', updated_at: now })
      .eq('id', orderId)
      .eq('tech_id', currentTechnician.id)
      .eq('accepted_by_tech', currentTechnician.id)
      .select().single();
    if (error) throw error;
    const idx = allOrders.findIndex(o => String(o.id) === String(orderId));
    if (idx !== -1) allOrders[idx] = { ...allOrders[idx], ...data };
    renderTechOrders();
    showAlert('✅ تم بدء المعالجة', 'success', 3000);
  } catch (e) {
    showAlert('تعذر بدء المعالجة: ' + (e.message || e), 'error');
  }
}

// ===== الفني في الطريق'''
s, n = accept_pattern.subn(accept_replacement, s, count=1)
if n != 1:
    raise SystemExit('technician accept function not found')

old_button = "${o.status==='in-progress'&&isMine&&perms.updateStatus?`\n          ${!o.on_the_way_at ? `<button onclick=\"techOnTheWay('${o.id}')\" style=\"flex:1;min-width:100px;background:linear-gradient(135deg,#0ea5e9,#0284c7);color:white;border:none;padding:10px;border-radius:50px;cursor:pointer;font-size:0.85rem;font-family:inherit;font-weight:700;\"><i class=\"fas fa-car\"></i> في الطريق</button>` : `<div style=\"flex:1;min-width:100px;text-align:center;padding:10px;background:#eff6ff;border-radius:50px;color:#0284c7;font-size:0.8rem;font-weight:700;\"><i class=\"fas fa-car\"></i> في الطريق ✓</div>`}\n          <button onclick=\"techFinishAndInvoice('${o.id}','${o.user_id||o.userId||''}','${(o.name||'').replace(/'/g,'')}','${o.phone||''}','${(o.service||'').replace(/'/g,'')}')\" style=\"flex:2;min-width:100px;background:linear-gradient(135deg,#10b981,#059669);color:white;border:none;padding:10px;border-radius:50px;cursor:pointer;font-size:0.85rem;font-family:inherit;font-weight:700;\"><i class=\"fas fa-check-circle\"></i> إنهاء وإنشاء فاتورة</button>\n        `:''}"
new_button = "${o.status==='accepted'&&isMine&&perms.updateStatus?`<button onclick=\"techStartProcessing('${o.id}')\" style=\"flex:2;min-width:130px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:white;border:none;padding:10px;border-radius:50px;cursor:pointer;font-size:0.85rem;font-family:inherit;font-weight:700;\"><i class=\"fas fa-tools\"></i> بدء المعالجة</button>`:''}\n        ${o.status==='in-progress'&&isMine&&perms.updateStatus?`\n          ${!o.on_the_way_at ? `<button onclick=\"techOnTheWay('${o.id}')\" style=\"flex:1;min-width:100px;background:linear-gradient(135deg,#0ea5e9,#0284c7);color:white;border:none;padding:10px;border-radius:50px;cursor:pointer;font-size:0.85rem;font-family:inherit;font-weight:700;\"><i class=\"fas fa-car\"></i> في الطريق</button>` : `<div style=\"flex:1;min-width:100px;text-align:center;padding:10px;background:#eff6ff;border-radius:50px;color:#0284c7;font-size:0.8rem;font-weight:700;\"><i class=\"fas fa-car\"></i> في الطريق ✓</div>`}\n          <button onclick=\"techFinishAndInvoice('${o.id}','${o.user_id||o.userId||''}','${(o.name||'').replace(/'/g,'')}','${o.phone||''}','${(o.service||'').replace(/'/g,'')}')\" style=\"flex:2;min-width:100px;background:linear-gradient(135deg,#10b981,#059669);color:white;border:none;padding:10px;border-radius:50px;cursor:pointer;font-size:0.85rem;font-family:inherit;font-weight:700;\"><i class=\"fas fa-check-circle\"></i> إنهاء وإنشاء فاتورة</button>\n        `:''}"
if old_button not in s:
    raise SystemExit('technician action button block not found')
s = s.replace(old_button, new_button, 1)

p.write_text(s, encoding='utf-8')
print('tracker patch prepared successfully')
