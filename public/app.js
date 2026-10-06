/* Invoice Manager SPA */
const $ = s => document.querySelector(s);
const state = { token: localStorage.getItem('token') || '', user: null, business: null, route: 'dashboard', params: {} };
// Dead sessions (deleted user, wiped DB, changed secret) make EVERY request
// fail with 401. Bounce to the login screen instead of failing silently.
function expireSession() {
  localStorage.removeItem('token');
  try { sessionStorage.setItem('session_expired', '1'); } catch {}
  location.reload();
}
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token, ...(opts.headers || {}) } });
  if (r.status === 401) { expireSession(); throw new Error('Session expired — please log in again'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};
const apiForm = async (path, formData, method = 'POST') => {
  const r = await fetch(path, { method, headers: { Authorization: 'Bearer ' + state.token }, body: formData });
  if (r.status === 401) { expireSession(); throw new Error('Session expired — please log in again'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Upload failed');
  return j;
};
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);

function toast(msg, cls = '') {  const d = document.createElement('div');
  d.className = 'toast ' + cls; d.textContent = msg;
  $('#toast-root').appendChild(d);
  setTimeout(() => d.remove(), 3500);
}
function modal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-bg').addEventListener('click', e => { if (e.target.classList.contains('modal-bg')) closeModal(); });
  return root.querySelector('.modal');
}
function closeModal() { $('#modal-root').innerHTML = ''; }

// Shrink oversized uploads in-browser (phone photos bloat every PDF they're
// embedded in). Returns the original file when already small or on any error.
function processImage(file, maxDim) {
  return new Promise(resolve => {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          if (!w || !h || Math.max(w, h) <= maxDim) return resolve(file);
          const k = maxDim / Math.max(w, h);
          w = Math.round(w * k); h = Math.round(h * k);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          c.toBlob(b => resolve(b || file), file.type || 'image/png');
        } catch { resolve(file); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    } catch { resolve(file); }
  });
}

const NAV = [
  { id: 'dashboard', label: '📊 Dashboard', roles: ['admin', 'staff', 'accountant'] },
  { id: 'new', label: '🧾 New Invoice', roles: ['admin', 'staff', 'accountant'] },
  { id: 'invoices', label: '📁 Invoices', roles: ['admin', 'staff', 'accountant'] },
  { id: 'customers', label: '👥 Customers', roles: ['admin', 'staff', 'accountant'] },
  { id: 'products', label: '📦 Products', roles: ['admin', 'staff', 'accountant'] },
  { id: 'payments', label: '💳 Payments', roles: ['admin', 'staff', 'accountant'] },
  { id: 'reports', label: '📈 Reports', roles: ['admin'] },
  { id: 'staff', label: '🧑‍💼 Staff', roles: ['admin'] },
  { id: 'settings', label: '⚙️ Business Settings', roles: ['admin'] },
  { id: 'audit', label: '📝 Audit Logs', roles: ['admin', 'accountant'] },
];

function renderNav() {
  $('#nav').innerHTML = NAV.filter(n => n.roles.includes(state.user.role))
    .map(n => `<button data-nav="${n.id}" class="${state.route === n.id ? 'active' : ''}">${n.label}</button>`).join('');
  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => go(b.dataset.nav));
  // mobile bottom nav: key actions + menu
  const bn = $('#bottomnav');
  if (bn) {
    const items = [
      { id: 'dashboard', icon: '📊', label: 'Home' },
      { id: 'new', icon: '➕', label: 'New' },
      { id: 'invoices', icon: '📁', label: 'Invoices' },
      { id: 'customers', icon: '👥', label: 'Clients' },
    ];
    bn.innerHTML = items.map(i => `<button data-nav="${i.id}" class="${state.route === i.id ? 'active' : ''}"><span class="bi">${i.icon}</span>${i.label}</button>`).join('')
      + `<button id="bn-menu"><span class="bi">☰</span>Menu</button>`;
    bn.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => go(b.dataset.nav));
    bn.querySelector('#bn-menu').onclick = () => $('#sidebar').classList.add('open');
  }
  $('#user-box').innerHTML = `<b>${esc(state.user.name)}</b><br><span class="muted">${esc(state.user.role)} • ${esc(state.user.email)}</span>`;
}

function go(route, params = {}) {
  state.route = route; state.params = params;
  renderNav();
  $('#sidebar').classList.remove('open');
  const titles = { dashboard: 'Dashboard', new: 'New Invoice', invoices: 'Invoices', invoice: 'Invoice Detail', customers: 'Customers', products: 'Products / SKUs', payments: 'Payments', reports: 'Reports', staff: 'Staff Management', settings: 'Business Profile / Settings', audit: 'Audit Logs' };
  $('#page-title').textContent = titles[route] || route;
  ({ dashboard: vDashboard, new: vNewInvoice, invoices: vInvoices, invoice: vInvoiceDetail, customers: vCustomers, products: vProducts, payments: vPayments, reports: vReports, staff: vStaff, settings: vSettings, audit: vAudit })[route]();
}
window.go = go;

// ---------- charts (no dependency) ----------
function barChart(canvas, labels, values, color = '#0F766E') {
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.offsetWidth * 2, H = canvas.height = 440;
  ctx.clearRect(0, 0, W, H);
  const max = Math.max(...values, 1);
  const bw = W / (values.length * 1.6);
  values.forEach((v, i) => {
    const h = (H - 80) * v / max;
    const x = i * (W / values.length) + (W / values.length - bw) / 2;
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, H - 50 - h, bw, h, 8); ctx.fill();
    ctx.fillStyle = '#6B7280'; ctx.font = '20px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(labels[i].slice(2), x + bw / 2, H - 18);
  });
}
function donut(canvas, parts) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.offsetWidth * 2, H = canvas.height = 440;
  ctx.clearRect(0, 0, W, H);
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  let a = -Math.PI / 2;
  const cx = W / 2, cy = H / 2 - 30, R = Math.min(W, H) / 2 - 60;
  parts.forEach(p => {
    const a2 = a + (p.value / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a, a2); ctx.closePath();
    ctx.fillStyle = p.color; ctx.fill(); a = a2;
  });
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.55, 0, 7); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#111827'; ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(parts.reduce((s, p) => s + p.value, 0) + '', cx, cy + 10);
  // legend
  let ly = H - 90; ctx.textAlign = 'left'; ctx.font = '20px sans-serif';
  parts.forEach(p => { ctx.fillStyle = p.color; ctx.fillRect(20, ly, 22, 22); ctx.fillStyle = '#374151'; ctx.fillText(`${p.label}: ${p.value}`, 52, ly + 18); ly += 34; });
}

// ---------- DASHBOARD ----------
async function vDashboard() {
  $('#view').innerHTML = '<p>Loading dashboard…</p>';
  const d = await api('/api/dashboard').catch(e => ({ err: e.message }));
  if (d.err) { $('#view').innerHTML = `<p class="error">${esc(d.err)}</p>`; return; }
  const k = d.kpis;
  const stPill = s => `<span class="pill st-${esc(s).replace(' ', '.')}">${esc(s)}</span>`;
  $('#view').innerHTML = `
    <div class="grid kpis">
      <div class="card kpi accent"><div class="v">${inr(k.totalInvoiced)}</div><div class="l">Total invoiced • ${k.totalInvoices} invoices</div></div>
      <div class="card kpi"><div class="v">${inr(k.totalReceived)}</div><div class="l">Total received</div></div>
      <div class="card kpi"><div class="v">${inr(k.totalOutstanding)}</div><div class="l">Outstanding</div></div>
      <div class="card kpi"><div class="v">${inr(k.overdueAmount)}</div><div class="l">Overdue amount</div></div>
    </div>
    <div class="grid cols2 mt">
      <div class="card"><h3>Status breakdown</h3>
        <div class="flex">${Object.entries(k.byStatus).map(([s, v]) => `${stPill(s)} <b>${v.c}</b> (${inr(v.t)})`).join(' &nbsp; ')}</div>
        <canvas class="chart mt" id="ch-status"></canvas></div>
      <div class="card"><h3>Revenue by month</h3><canvas class="chart" id="ch-rev"></canvas></div>
    </div>
    <div class="grid cols2 mt">
      <div class="card"><h3>Top customers</h3><table>${d.topCustomers.map(c => `<tr><td>${esc(c.name || '-')}</td><td>${c.n} inv</td><td style="text-align:right">${inr(c.total)}</td></tr>`).join('') || '<tr><td>No data</td></tr>'}</table></div>
      <div class="card"><h3>Top products</h3><table>${d.topProducts.map(p => `<tr><td><b>${esc(p.name)}</b> <span class="muted">${esc(p.sku)}</span></td><td>${p.qty}</td><td style="text-align:right">${inr(p.total)}</td></tr>`).join('') || '<tr><td>No data</td></tr>'}</table></div>
    </div>
    <div class="card mt"><h3>Recent invoices</h3>
      <div class="toolbar"><input id="d-q" placeholder="Search number / customer / SKU…"><select id="d-f"><option value="All">All statuses</option><option>Paid</option><option>Partially Paid</option><option>Unpaid</option><option>Overdue</option><option>Cancelled</option></select></div>
      <div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Total</th><th>Paid</th><th>Outstanding</th><th>Status</th><th>By</th></tr></thead>
      <tbody id="d-rows"></tbody></table></div></div>`;
  donut($('#ch-status'), [
    { label: 'Paid', value: k.byStatus.Paid?.c || 0, color: '#16A34A' },
    { label: 'Partial', value: k.byStatus['Partially Paid']?.c || 0, color: '#2563EB' },
    { label: 'Unpaid', value: k.byStatus.Unpaid?.c || 0, color: '#9CA3AF' },
    { label: 'Overdue', value: k.byStatus.Overdue?.c || 0, color: '#DC2626' },
  ]);
  barChart($('#ch-rev'), d.revenueByMonth.map(r => r.m), d.revenueByMonth.map(r => r.t));
  const draw = () => {
    const q = ($('#d-q').value || '').toLowerCase(), f = $('#d-f').value;
    $('#d-rows').innerHTML = d.recent.filter(r =>
      (f === 'All' || r.status === f) &&
      (!q || (r.invoice_number + r.cust_name + (r.cust_phone || '')).toLowerCase().includes(q))
    ).map(r => `<tr style="cursor:pointer" onclick="go('invoice',{id:'${r.id}'})">
      <td><b>${esc(r.invoice_number)}</b></td><td>${esc(r.cust_name)}</td><td>${esc(r.invoice_date)}</td>
      <td>${inr(r.total)}</td><td>${inr(r.paid)}</td><td>${inr(r.outstanding)}</td>
      <td>${stPill(r.status)}</td><td>${esc(r.created_by_name || '-')}</td></tr>`).join('') || '<tr><td colspan=8>No invoices</td></tr>';
  };
  $('#d-q').oninput = draw; $('#d-f').onchange = draw; draw();
}

// ---------- NEW INVOICE ----------
let NI = { items: [], customers: [], products: [], nextNum: '', biz: null };
async function vNewInvoice() {
  $('#view').innerHTML = '<p>Loading…</p>';
  const [biz, custs, prods, nxt] = await Promise.all([
    api('/api/business'), api('/api/customers'), api('/api/products?active=1'), api('/api/invoices/next-number')
  ]);
  NI = { items: [{ sku: '', name: '', description: '', quantity: 1, unit_price: 0, discount: 0, tax: 0, product_id: null }], customers: custs.customers, products: prods.products, nextNum: nxt.next, biz: biz.business };
  const qrWarn = biz.business.show_qr && !biz.business.qr_image_path
    ? `<div class="warn">⚠ Payment QR display is <b>ON</b> but no QR has been uploaded. Invoices will be blocked until you <a href="#" onclick="go('settings');return false">upload a QR in Business Settings</a> or turn the toggle OFF. The system will never auto-generate a QR.</div>` : '';
  $('#view').innerHTML = `
    ${qrWarn}
    <div class="grid cols2">
    <div class="card"><h3>Customer</h3>
      <label>Select existing<input id="ni-cust-search" list="cust-list" placeholder="Type to search…"></label>
      <datalist id="cust-list">${NI.customers.map(c => `<option value="${esc(c.name)} — ${esc(c.phone)}">${esc(c.business_name || '')}</option>`).join('')}</datalist>
      <div class="flex"><button class="btn sm" id="ni-pick">Use selected</button><button class="btn sm ghost" id="ni-newc">+ New customer</button></div>
      <div id="ni-cust-form" class="mt"></div>
    </div>
    <div class="card"><h3>Invoice details <span class="muted">(${esc(NI.nextNum)} reserved on save)</span></h3>
      <div class="grid cols2">
        <label>Invoice date<input type="date" id="ni-date" value="${today()}"></label>
        <label>Due date <span class="muted">(optional)</span><input type="date" id="ni-due"></label>
      </div>
      <label>Notes<textarea id="ni-notes">${esc(biz.business.default_notes || '')}</textarea></label>
      <label>Terms & conditions<textarea id="ni-terms">${esc(biz.business.default_terms || '')}</textarea></label>
      <label><input type="checkbox" id="ni-showqr" ${biz.business.show_qr ? 'checked' : ''} style="width:auto"> Show business payment QR on this invoice</label>
    </div></div>
    <div class="card mt"><h3>Items</h3>
      <label style="max-width:340px">Search product / SKU<input id="ni-prod-search" list="prod-list" placeholder="Type SKU or name, Enter to add…"></label>
      <datalist id="prod-list">${NI.products.map(p => `<option value="${esc(p.sku)} — ${esc(p.name)}">₹${p.price}</option>`).join('')}</datalist>
      <div id="ni-items"></div>
      <button class="btn sm" id="ni-add">+ Add item</button>
      <div class="flex mt" style="justify-content:flex-end"><label style="max-width:220px;margin:0">Invoice discount (₹, optional)<input id="ni-xdisc" type="number" min="0" step="0.01" value="0"></label></div>
      <div class="totals mt" id="ni-totals"></div>
    </div>
    <div class="flex mt"><button class="btn primary" id="ni-save">Review & Generate PDF</button><button class="btn ghost" id="ni-preview-btn">Preview</button></div>
    <div id="ni-preview" class="mt"></div>`;

  let selCust = null;
  const custForm = (c = {}) => $('#ni-cust-form').innerHTML = `
    <div class="grid cols2">
      <label>Name*<input id="nc-name" value="${esc(c.name || selCust?.name || '')}"></label>
      <label>Business<input id="nc-biz" value="${esc(c.business_name || selCust?.business_name || '')}"></label>
      <label>Phone<input id="nc-phone" value="${esc(c.phone || selCust?.phone || '')}"></label>
      <label>Email<input id="nc-email" value="${esc(c.email || selCust?.email || '')}"></label>
    </div>
    <label>Address<input id="nc-addr" value="${esc(c.address || selCust?.address || '')}"></label>
    <label>GSTIN<input id="nc-gst" value="${esc(c.gstin || selCust?.gstin || '')}"></label>`;
  custForm();
  $('#ni-newc').onclick = () => { selCust = null; $('#ni-cust-search').value = ''; custForm({}); };
  $('#ni-pick').onclick = () => {
    const v = $('#ni-cust-search').value.split(' — ')[0].trim();
    selCust = NI.customers.find(c => c.name === v) || null;
    if (!selCust) return toast('Customer not found — fill the form to create new', 'err');
    custForm(); toast('Customer selected: ' + selCust.name, 'ok');
  };

  const drawItems = () => {
    $('#ni-items').innerHTML = NI.items.map((it, i) => `
      <div class="item-row">
        <label>SKU<input data-i="${i}" data-k="sku" value="${esc(it.sku)}"></label>
        <label>Item*<input data-i="${i}" data-k="name" value="${esc(it.name)}" placeholder="Item name"></label>
        <label>Qty<input data-i="${i}" data-k="quantity" type="number" min="0" step="0.01" value="${it.quantity}"></label>
        <label>Price<input data-i="${i}" data-k="unit_price" type="number" min="0" step="0.01" value="${it.unit_price}"></label>
        <label>Disc<input data-i="${i}" data-k="discount" type="number" min="0" step="0.01" value="${it.discount}"></label>
        <label>Tax%<input data-i="${i}" data-k="tax" type="number" min="0" step="0.01" value="${it.tax}"></label>
        <label>Total<input value="${inr(lineTotal(it))}" disabled></label>
        <button class="btn sm danger" data-del="${i}">✕</button>
      </div>
      <div style="margin:-4px 0 8px"><input data-i="${i}" data-k="description" placeholder="Description (optional)" value="${esc(it.description || '')}" style="font-size:12px"></div>`).join('');
    document.querySelectorAll('#ni-items input').forEach(inp => inp.oninput = () => {
      const i = +inp.dataset.i, k = inp.dataset.k;
      NI.items[i][k] = (['quantity', 'unit_price', 'discount', 'tax'].includes(k)) ? Number(inp.value || 0) : inp.value;
      drawTotals();
      const tot = inp.closest('.item-row')?.querySelector('input[disabled]');
      if (tot) tot.value = inr(lineTotal(NI.items[i]));
    });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { NI.items.splice(+b.dataset.del, 1); if (!NI.items.length) NI.items.push({ sku: '', name: '', description: '', quantity: 1, unit_price: 0, discount: 0, tax: 0, product_id: null }); drawItems(); drawTotals(); });
    drawTotals();
  };
  const lineTotal = it => (it.quantity * it.unit_price - it.discount) * (1 + (it.tax || 0) / 100);
  const totals = () => {
    let s = 0, d = 0, t = 0;
    NI.items.forEach(it => { s += it.quantity * it.unit_price; d += +it.discount || 0; t += (it.quantity * it.unit_price - it.discount) * (it.tax || 0) / 100; });
    const xd = Math.max(0, +($('#ni-xdisc')?.value || 0));
    d = Math.round((d + xd) * 100) / 100;
    t = Math.round(t * 100) / 100; s = Math.round(s * 100) / 100;
    return { s, d, xd, t, g: Math.round((s - d + t) * 100) / 100 };
  };
  const drawTotals = () => {
    const x = totals();
    $('#ni-totals').innerHTML = `<div class="row"><span>Subtotal</span><b>${inr(x.s)}</b></div>
      ${x.d > 0 ? `<div class="row"><span>Discount</span><b>− ${inr(x.d)}</b></div>` : ''}
      ${x.t > 0 ? `<div class="row"><span>Tax</span><b>${inr(x.t)}</b></div>` : ''}
      <div class="row grand"><span>Grand total</span><span>${inr(x.g)}</span></div>`;
  };
  $('#ni-add').onclick = () => { NI.items.push({ sku: '', name: '', description: '', quantity: 1, unit_price: 0, discount: 0, tax: 0, product_id: null }); drawItems(); };
  $('#ni-prod-search').onchange = e => {
    const v = e.target.value.split(' — ')[0].trim();
    const p = NI.products.find(x => x.sku === v || `${x.sku} — ${x.name}` === e.target.value);
    if (!p) return;
    const empty = NI.items.find(i => !i.name);
    const row = empty || { sku: '', name: '', description: '', quantity: 1, unit_price: 0, discount: 0, tax: 0, product_id: null };
    Object.assign(row, { sku: p.sku, name: p.name, description: p.description || '', unit_price: p.price, tax: p.tax, product_id: p.id });
    if (!empty) NI.items.push(row);
    e.target.value = ''; drawItems(); toast(`Added ${p.name}`, 'ok');
  };
  drawItems();
  $('#ni-xdisc').oninput = drawTotals;

  $('#ni-preview-btn').onclick = () => {
    const payload = collect();
    if (!payload) return;
    $('#ni-preview').innerHTML = `<h3>Preview (matches PDF layout)</h3>` + previewHtml(payload);
    $('#ni-preview').scrollIntoView({ behavior: 'smooth' });
  };
  const collect = () => {
    const name = $('#nc-name').value.trim();
    if (!name) { toast('Customer name required', 'err'); return null; }
    if (NI.items.some(i => !i.name)) { toast('Every item needs a name', 'err'); return null; }
    const x = totals();
    if (x.g <= 0) { toast('Total must be > 0', 'err'); return null; }
    return {
      customer: { name, business_name: $('#nc-biz').value, phone: $('#nc-phone').value, email: $('#nc-email').value, address: $('#nc-addr').value, gstin: $('#nc-gst').value },
      customer_id: selCust?.id || null, invoice_date: $('#ni-date').value || today(), due_date: $('#ni-due').value || '',
      notes: $('#ni-notes').value, terms: $('#ni-terms').value, items: NI.items, show_qr: $('#ni-showqr').checked, totals: x,
      extra_discount: x.xd || 0
    };
  };
  const previewHtml = p => `
    <div class="inv-preview" style="display:flex">
      <div style="width:86px;min-height:560px;background:linear-gradient(180deg,#5E17EB,#3B1470);border-radius:12px 0 0 12px;display:flex;flex-direction:column;align-items:center;padding:14px 0;gap:10px">
        <div style="width:52px;height:52px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;color:#5E17EB">◈</div>
        <div style="width:44px;height:44px;border:4px solid #FF4848;border-radius:50%"></div>
        <div style="width:40px;height:40px;border:9px solid #FFA51F;border-radius:50%"></div>
        <div style="width:40px;height:40px;border:5px solid #FF4848;border-radius:50%"></div>
      </div>
      <div style="flex:1;padding:20px;min-width:0">
      <div style="text-align:center"><div style="font-size:38px;font-weight:800;color:#5E17EB;letter-spacing:1px">INVOICE</div>
      <div style="font-size:13px;font-weight:800;color:#5E17EB">INVOICE NO #${esc(NI.nextNum)}</div>
      <div class="small muted">${esc(NI.biz.business_name)} • ${esc(NI.biz.phone || '')}</div></div>
      <div class="flex" style="justify-content:space-between;margin-top:12px"><div><div style="color:#5E17EB;font-weight:700;font-size:12px">invoice to :</div>
        <div style="color:#5E17EB;font-weight:800;font-size:22px">${esc(p.customer.name.toUpperCase())}</div>
        <div class="small muted">${esc(p.customer.address)} ${esc(p.customer.phone)}</div></div>
        <div style="color:#5E17EB;font-weight:700;font-size:12px">${esc(p.invoice_date)}</div></div>
      <table class="inv-table"><thead><tr><th style="text-align:left">Item Description</th><th>Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${p.items.map((it, i) => `<tr><td style="text-align:left"><b>${esc(it.name)}</b><br><span class="muted small">${esc(it.sku || '')} ${esc(it.description || '')}</span></td><td>${it.quantity}</td><td style="text-align:right">${inr(it.unit_price)}</td><td style="text-align:right">${inr(lineTotal(it))}</td></tr>`).join('')}</tbody></table>
      <div class="flex" style="justify-content:flex-end;gap:24px;margin-top:8px"><b>Sub Total</b><b>${inr(p.totals.s)}</b></div>
      <div style="display:flex;justify-content:flex-end;margin-top:6px"><div style="background:#5E17EB;color:#fff;font-weight:800;padding:6px 14px;display:flex;gap:40px"><span>TOTAL</span><span>${inr(p.totals.g)}</span></div></div>
      <div class="flex" style="justify-content:space-between;margin-top:14px"><div>
        ${p.show_qr ? `<div style="color:#5E17EB;font-weight:800">Payment QR :</div>` + (NI.biz.qr_image_path ? `<img src="/${esc(NI.biz.qr_image_path)}" style="max-width:120px">` : '<span class="small">⚠ QR enabled but none uploaded</span>') : '<span class="small muted">QR hidden (toggle off)</span>'}
        <div style="color:#5E17EB;font-weight:800;margin-top:6px">Payment Method :</div>
        <div class="small"><b>UPI ID : ${esc(NI.biz.upi_id || '-')}</b></div></div>
        <div style="color:#5E17EB;font-style:italic;font-weight:700;font-size:40px;line-height:1">Thank<br>You</div></div>
      <div class="flex small" style="justify-content:space-between;color:#5E17EB;font-weight:700;margin-top:14px"><span>${esc(NI.biz.phone || '')}</span><span>${esc(NI.biz.city || '')}${NI.biz.state ? ', ' + esc(NI.biz.state) : ''}</span><span>${esc(NI.biz.website || '')}</span></div>
      </div></div>`;

  $('#ni-save').onclick = async () => {
    const p = collect();
    if (!p) return;
    const btn = $('#ni-save'); btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const body = {
        customer_id: p.customer_id, new_customer: p.customer_id ? null : p.customer,
        invoice_date: p.invoice_date, due_date: p.due_date, notes: p.notes, terms: p.terms,
        show_qr: p.show_qr,
        items: p.items.map(i => ({ product_id: i.product_id, sku: i.sku, name: i.name, description: i.description, quantity: i.quantity, unit_price: i.unit_price, discount: i.discount, tax: i.tax }))
      };
      const r = await api('/api/invoices', { method: 'POST', body: JSON.stringify(body) });
      toast('Invoice ' + r.invoice_number + ' created', 'ok');
      go('invoice', { id: r.id });
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = 'Review & Generate PDF'; }
  };
}

// ---------- INVOICES ----------
async function vInvoices() {
  $('#view').innerHTML = `<div class="toolbar">
    <input id="i-q" placeholder="Search number / customer / SKU…">
    <select id="i-s"><option value="All">All</option><option>Paid</option><option>Partially Paid</option><option>Unpaid</option><option>Overdue</option><option>Cancelled</option></select>
    <input type="date" id="i-from"><input type="date" id="i-to">
    <select id="i-sort"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="total_desc">Total ↓</option><option value="total_asc">Total ↑</option></select>
    <button class="btn sm" id="i-go">Filter</button></div>
    <div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Due</th><th>Total</th><th>Paid</th><th>Outstanding</th><th>Status</th><th>Actions</th></tr></thead><tbody id="i-rows"></tbody></table></div>`;
  const load = async () => {
    const p = new URLSearchParams({ q: $('#i-q').value, status: $('#i-s').value, from: $('#i-from').value, to: $('#i-to').value, sort: $('#i-sort').value });
    const { invoices } = await api('/api/invoices?' + p);
    $('#i-rows').innerHTML = invoices.map(r => `<tr style="cursor:pointer" onclick="go('invoice',{id:'${r.id}'})">
      <td><b>${esc(r.invoice_number)}</b></td><td>${esc(r.cust_name)}</td><td>${esc(r.invoice_date)}</td><td>${esc(r.due_date || '-')}</td>
      <td>${inr(r.total)}</td><td>${inr(r.paid)}</td><td>${inr(r.outstanding)}</td>
      <td><span class="pill st-${esc(r.status).replace(' ', '.')}">${esc(r.status)}</span></td>
      <td><div class="flex" style="gap:4px;flex-wrap:nowrap">
        ${['Unpaid', 'Partially Paid', 'Overdue'].includes(r.status) ? `<button class="btn sm primary" onclick="event.stopPropagation();openPayModal('${r.id}')">Pay</button>` : ''}
        <button class="btn sm ghost" title="Download PDF" onclick="event.stopPropagation();dlPdf(event,'${r.id}','${esc(r.invoice_number)}')">PDF</button>
      </div></td></tr>`).join('') || '<tr><td colspan=9>No invoices. <a href="#" onclick="go(\'new\');return false">Create one</a></td></tr>';
  };
  $('#i-go').onclick = load; await load();
}

async function vInvoiceDetail() {
  const id = state.params.id;
  $('#view').innerHTML = '<p>Loading…</p>';
  const { invoice, items, payments } = await api('/api/invoices/' + id).catch(e => ({ err: e.message }));
  if (!invoice && !items) { $('#view').innerHTML = '<p class="error">Not found</p>'; return; }
  const canCancel = state.user.role === 'admin', canEdit = ['admin', 'staff'].includes(state.user.role);
  $('#view').innerHTML = `
    <div class="flex mb"><button class="btn sm ghost" onclick="go('invoices')">← Back</button>
      <h2 style="font-size:22px">${esc(invoice.invoice_number)} <span class="pill st-${esc(invoice.status).replace(' ', '.')}">${esc(invoice.status)}</span></h2></div>
    <div class="grid cols3">
      <div class="card kpi"><div class="v">${inr(invoice.total)}</div><div class="l">Total • ${esc(invoice.cust_name)}</div></div>
      <div class="card kpi"><div class="v">${inr(invoice.paid)}</div><div class="l">Paid (${payments.length} payments)</div></div>
      <div class="card kpi"><div class="v">${inr(invoice.outstanding)}</div><div class="l">Outstanding • Due ${esc(invoice.due_date || '-')}</div></div>
    </div>
    <div class="flex mt">
      <a class="btn primary sm" href="/api/invoices/${invoice.id}/pdf" onclick="return dlPdf(event,'${invoice.id}','${esc(invoice.invoice_number)}')">Download PDF</a>
      <button class="btn sm" onclick="printPdf('${invoice.id}')">Print</button>
      <button class="btn sm" id="pay-btn">Record payment</button>
      <button class="btn sm ghost" id="dup-btn">Duplicate</button>
      ${canEdit ? '<button class="btn sm ghost" id="edit-btn">Edit</button>' : ''}
      ${canCancel && invoice.status !== 'Cancelled' ? '<button class="btn sm danger" id="cancel-btn">Cancel invoice</button>' : ''}
    </div>
    <div class="grid cols2 mt">
      <div class="card"><h3>Items</h3><table>${items.map((it, i) => `<tr><td>${i + 1}</td><td><b>${esc(it.name)}</b> <span class="muted">${esc(it.sku)}</span><br><span class="small muted">${esc(it.description || '')}</span></td><td>${it.quantity} × ${inr(it.unit_price)}</td><td style="text-align:right">${inr(it.total)}</td></tr>`).join('')}</table>
        <div class="totals mt"><div class="row"><span>Subtotal</span><b>${inr(invoice.subtotal)}</b></div><div class="row"><span>Discount</span><b>${inr(invoice.discount_total)}</b></div>${invoice.extra_discount > 0 ? `<div class="row"><span class="small muted">incl. invoice discount</span><b class="small">− ${inr(invoice.extra_discount)}</b></div>` : ''}<div class="row"><span>Tax</span><b>${inr(invoice.tax_total)}</b></div><div class="row grand"><span>Total</span><span>${inr(invoice.total)}</span></div></div></div>
      <div class="card"><h3>Payment history</h3>
        ${payments.map(p => `<div class="flex" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0">
          <div><b>${inr(p.amount)}</b> <span class="pill st-Unpaid">${esc(p.method)}</span><br><span class="small muted">${esc(p.payment_date)} • ${esc(p.reference || '')} • by ${esc(p.recorded_by_name || '-')}</span><br><span class="small">${esc(p.note || '')}</span></div>
          ${state.user.role === 'admin' ? `<button class="btn sm ghost" onclick="delPay('${p.id}')">Delete</button>` : ''}</div>`).join('') || '<p class="muted">No payments yet.</p>'}
        <p class="small muted mt">Status is derived from payment records: Paid ≥ total, Partial in between, Unpaid = 0, Overdue = past due + outstanding.</p></div>
    </div>
    <div class="card mt"><h3>Customer snapshot (frozen on invoice)</h3><p class="small">${esc(invoice.cust_name)} • ${esc(invoice.cust_business || '')} • ${esc(invoice.cust_address || '')} • ${esc(invoice.cust_phone || '')} • ${esc(invoice.cust_email || '')} ${invoice.cust_gstin ? '• GSTIN ' + esc(invoice.cust_gstin) : ''}</p>
    ${invoice.notes ? `<h3>Notes</h3><p class="small">${esc(invoice.notes)}</p>` : ''}${invoice.terms ? `<h3>Terms</h3><p class="small">${esc(invoice.terms)}</p>` : ''}</div>`;

  $('#pay-btn').onclick = () => openPayModal(invoice.id);
  $('#dup-btn').onclick = async () => {
    if (!confirm(`Create a copy of ${invoice.invoice_number} as a new invoice with the next number?`)) return;
    try {
      const r = await api(`/api/invoices/${invoice.id}/duplicate`, { method: 'POST' });
      toast('Duplicated as ' + r.invoice_number, 'ok'); go('invoice', { id: r.id });
    } catch (e) { toast(e.message, 'err'); }
  };
  const cb = $('#cancel-btn');
  if (cb) cb.onclick = async () => {
    if (!confirm(`Cancel ${invoice.invoice_number}? It will stay in the system for audit.`)) return;
    await api(`/api/invoices/${invoice.id}/cancel`, { method: 'POST' });
    toast('Invoice cancelled', 'ok'); vInvoiceDetail();
  };
  const eb = $('#edit-btn');
  if (eb) eb.onclick = async () => {
    const { invoice: iv, items: its, payments: pays } = await api('/api/invoices/' + invoice.id).catch(e => ({ err: e.message }));
    if (!iv && !its) { toast('Could not load invoice', 'err'); return; }
    const canItems = pays.length === 0;
    let rows = its.map(it => ({ ...it }));
    const m = modal(`<h3>Edit invoice ${esc(iv.invoice_number)}</h3>
      <label>Due date <span class="muted">(clear to remove)</span><input id="e-due" type="date" value="${esc(iv.due_date || '')}"></label>
      ${canItems ? `<div id="e-items"></div><button class="btn sm" id="e-add">+ Add item</button>
      <label class="mt">Invoice discount (₹)<input id="e-xd" type="number" min="0" step="0.01" value="${iv.extra_discount || 0}"></label>`
        : '<p class="small muted">Items are locked — payments have already been recorded against this invoice. Cancel and recreate if items must change.</p>'}
      <label>Notes<textarea id="e-notes">${esc(iv.notes || '')}</textarea></label>
      <label>Terms<textarea id="e-terms">${esc(iv.terms || '')}</textarea></label>
      <div class="flex mt"><button class="btn primary" id="e-save">Save</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
    const drawE = () => {
      const box = m.querySelector('#e-items');
      if (!box) return;
      box.innerHTML = rows.map((it, i) => `<div class="item-row" style="grid-template-columns:1fr 60px 90px 70px 60px 32px">
        <label>Item<input data-i="${i}" data-k="name" value="${esc(it.name || '')}"></label>
        <label>Qty<input data-i="${i}" data-k="quantity" type="number" step="0.01" value="${it.quantity}"></label>
        <label>Price<input data-i="${i}" data-k="unit_price" type="number" step="0.01" value="${it.unit_price}"></label>
        <label>Disc<input data-i="${i}" data-k="discount" type="number" step="0.01" value="${it.discount || 0}"></label>
        <label>Tax%<input data-i="${i}" data-k="tax" type="number" step="0.01" value="${it.tax || 0}"></label>
        <button class="btn sm danger" data-del="${i}">✕</button></div>`).join('');
      box.querySelectorAll('input').forEach(inp => inp.oninput = () => {
        const i = +inp.dataset.i, k = inp.dataset.k;
        rows[i][k] = ['quantity', 'unit_price', 'discount', 'tax'].includes(k) ? Number(inp.value || 0) : inp.value;
      });
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { rows.splice(+b.dataset.del, 1); drawE(); });
      const add = m.querySelector('#e-add');
      if (add) add.onclick = () => { rows.push({ name: '', quantity: 1, unit_price: 0, discount: 0, tax: 0 }); drawE(); };
    };
    drawE();
    m.querySelector('#e-save').onclick = async () => {
      try {
        const body = { due_date: m.querySelector('#e-due').value, notes: m.querySelector('#e-notes').value, terms: m.querySelector('#e-terms').value };
        if (canItems) {
          body.extra_discount = +m.querySelector('#e-xd').value || 0;
          body.items = rows.map(r => ({ product_id: r.product_id || null, sku: r.sku || '', name: r.name, description: r.description || '', quantity: +r.quantity || 0, unit_price: +r.unit_price || 0, discount: +r.discount || 0, tax: +r.tax || 0 }));
        }
        await api('/api/invoices/' + invoice.id, { method: 'PUT', body: JSON.stringify(body) });
        closeModal(); toast('Saved', 'ok'); vInvoiceDetail();
      } catch (e) { toast(e.message, 'err'); }
    };
  };
}
window.delPay = async id => {
  if (!confirm('Delete this payment? Audit log will record it.')) return;
  try { await api('/api/payments/' + id, { method: 'DELETE' }); toast('Payment deleted', 'ok'); vInvoiceDetail(); }
  catch (e) { toast(e.message, 'err'); }
};
async function dlPdf(e, id, num) {
  if (e) e.preventDefault();
  // open the tab synchronously — async window.open() gets popup-blocked on mobile
  const tab = window.open('', '_blank');
  let r;
  try {
    r = await fetch(`/api/invoices/${id}/pdf`, { headers: { Authorization: 'Bearer ' + state.token } });
  } catch { if (tab) tab.close(); toast('PDF failed — check connection', 'err'); return false; }
  if (r.status === 401) { if (tab) tab.close(); return expireSession(); }
  if (!r.ok) { if (tab) tab.close(); toast('PDF failed', 'err'); return false; }
  const b = await r.blob();
  const url = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = url; a.download = num + '.pdf';
  document.body.appendChild(a); a.click(); a.remove();
  if (tab) tab.location.href = url;
  else window.open(url, '_blank');
  return false;
}
async function printPdf(id) {
  const r = await fetch(`/api/invoices/${id}/pdf`, { headers: { Authorization: 'Bearer ' + state.token } });
  if (r.status === 401) return expireSession();
  if (!r.ok) { toast('Print failed', 'err'); return; }
  const url = URL.createObjectURL(await r.blob());
  const fr = document.createElement('iframe');
  fr.style.display = 'none'; fr.src = url;
  fr.onload = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch {} };
  document.body.appendChild(fr);
}
window.printPdf = printPdf;
window.dlPdf = dlPdf; window.closeModal = closeModal;
// Global "record payment" flow — used from invoice detail AND invoice lists.
async function openPayModal(invId) {
  let inv;
  try { ({ invoice: inv } = await api('/api/invoices/' + invId)); }
  catch (e) { toast(e.message, 'err'); return; }
  if (inv.status === 'Paid') { toast('Invoice is already fully paid', 'err'); return; }
  if (inv.status === 'Cancelled') { toast('Cannot record payment on a cancelled invoice', 'err'); return; }
  const m = modal(`<h3>Record payment — ${esc(inv.invoice_number)}</h3>
    <p class="small muted">Total ${inr(inv.total)} • Paid ${inr(inv.paid)} • Outstanding ${inr(inv.outstanding)}</p>
    <label>Amount*<input id="p-amt" type="number" step="0.01" max="${inv.outstanding}" value="${inv.outstanding}"></label>
    <label>Method<select id="p-method"><option>UPI</option><option>Cash</option><option>Bank Transfer</option><option>Card</option><option>Other</option></select></label>
    <label>Date<input id="p-date" type="date" value="${today()}"></label>
    <label>Reference / TXN ID<input id="p-ref" placeholder="TXN123456"></label>
    <label>Note<input id="p-note"></label>
    <div class="flex mt"><button class="btn primary" id="p-save">Save payment</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
  m.querySelector('#p-save').onclick = async () => {
    try {
      await api(`/api/invoices/${invId}/payments`, { method: 'POST', body: JSON.stringify({ amount: +m.querySelector('#p-amt').value, method: m.querySelector('#p-method').value, payment_date: m.querySelector('#p-date').value, reference: m.querySelector('#p-ref').value, note: m.querySelector('#p-note').value }) });
      closeModal(); toast('Payment recorded', 'ok');
      go(state.route, state.params); // refresh wherever we are
    } catch (e) { toast(e.message, 'err'); }
  };
}
window.openPayModal = openPayModal;
async function dlBackup(e, name) {
  e.preventDefault();
  const r = await fetch(`/api/admin/backups/${encodeURIComponent(name)}`, { headers: { Authorization: 'Bearer ' + state.token } });
  if (r.status === 401) return expireSession();
  if (!r.ok) { toast('Download failed', 'err'); return false; }
  const b = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name; a.click();
  return false;
}
window.dlBackup = dlBackup;

// ---------- CUSTOMERS ----------
async function vCustomers() {
  $('#view').innerHTML = `<div class="toolbar"><input id="c-q" placeholder="Search customers…"><button class="btn sm primary" id="c-add">+ Customer</button></div><div id="c-list" class="grid cols3"></div>`;
  const load = async () => {
    const { customers } = await api('/api/customers?q=' + encodeURIComponent($('#c-q').value));
    $('#c-list').innerHTML = customers.map(c => `<div class="card"><b>${esc(c.name)}</b> <span class="muted small">${esc(c.business_name || '')}</span><br>
      <span class="small muted">${esc(c.phone || '')} • ${esc(c.email || '')}</span>
      <div class="flex mt"><span class="pill st-Unpaid">${c.total_invoices} inv</span><span class="small">${inr(c.total_invoiced)} • <b style="color:var(--red)">${inr(c.total_outstanding)}</b> due</span></div>
      <div class="flex mt"><button class="btn sm ghost" onclick="custDetail('${c.id}')">History</button><button class="btn sm ghost" onclick="custEdit('${c.id}')">Edit</button></div></div>`).join('') || '<p>No customers</p>';
  };
  $('#c-q').oninput = load;
  $('#c-add').onclick = () => custEdit(null);
  await load();
}
window.custDetail = async id => {
  const { customer, invoices } = await api('/api/customers/' + id);
  modal(`<h3>${esc(customer.name)} ${customer.business_name ? '• ' + esc(customer.business_name) : ''}</h3>
    <p class="small muted">${esc(customer.address || '')}<br>${esc(customer.phone || '')} • ${esc(customer.email || '')} ${customer.gstin ? '• GSTIN ' + esc(customer.gstin) : ''}</p>
    <h3>Invoices (${invoices.length})</h3>
    ${invoices.map(i => `<div class="flex" style="justify-content:space-between;border-top:1px solid var(--line);padding:6px 0"><span><b>${esc(i.invoice_number)}</b> • ${esc(i.invoice_date)} • ${inr(i.total)} • paid ${inr(i.paid)}</span><button class="btn sm ghost" onclick="closeModal();go('invoice',{id:'${i.id}'})">Open</button></div>`).join('') || '<p class="muted">None</p>'}
    <div class="mt"><button class="btn ghost" onclick="closeModal()">Close</button></div>`);
};
window.custEdit = async id => {
  let c = { name: '', business_name: '', address: '', phone: '', email: '', gstin: '', notes: '' };
  if (id) c = (await api('/api/customers')).customers.find(x => String(x.id) === String(id)) || c;
  const m = modal(`<h3>${id ? 'Edit' : 'New'} customer</h3>
    <label>Name*<input id="f-name" value="${esc(c.name)}"></label><label>Business<input id="f-biz" value="${esc(c.business_name || '')}"></label>
    <label>Phone<input id="f-phone" value="${esc(c.phone || '')}"></label><label>Email<input id="f-email" value="${esc(c.email || '')}"></label>
    <label>Address<input id="f-addr" value="${esc(c.address || '')}"></label><label>GSTIN<input id="f-gst" value="${esc(c.gstin || '')}"></label>
    <div class="flex mt"><button class="btn primary" id="f-save">Save</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
  m.querySelector('#f-save').onclick = async () => {
    const body = JSON.stringify({ name: m.querySelector('#f-name').value, business_name: m.querySelector('#f-biz').value, phone: m.querySelector('#f-phone').value, email: m.querySelector('#f-email').value, address: m.querySelector('#f-addr').value, gstin: m.querySelector('#f-gst').value });
    try { id ? await api('/api/customers/' + id, { method: 'PUT', body }) : await api('/api/customers', { method: 'POST', body }); closeModal(); toast('Saved', 'ok'); vCustomers(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

// ---------- PRODUCTS ----------
async function vProducts() {
  $('#view').innerHTML = `<div class="toolbar"><input id="p-q" placeholder="Search SKU / name…"><button class="btn sm primary" id="p-add">+ Product</button></div><div class="table-wrap"><table><thead><tr><th>SKU</th><th>Name</th><th>Price</th><th>Tax</th><th>Status</th><th></th></tr></thead><tbody id="p-rows"></tbody></table></div>`;
  const load = async () => {
    const { products } = await api('/api/products?q=' + encodeURIComponent($('#p-q').value));
    $('#p-rows').innerHTML = products.map(p => `<tr><td><b>${esc(p.sku)}</b></td><td><b>${esc(p.name)}</b><br><span class="small muted">${esc(p.description || '')}</span></td>
      <td>${inr(p.price)}</td><td>${p.tax}%</td><td>${p.active ? 'Active' : 'Inactive'}</td>
      <td><button class="btn sm ghost" onclick="prodEdit('${p.id}')">Edit</button></td></tr>`).join('');
  };
  $('#p-q').oninput = load; $('#p-add').onclick = () => prodEdit(null); await load();
}
window.prodEdit = async id => {
  let p = { sku: '', name: '', description: '', price: 0, tax: 0, active: 1 };
  if (id) p = (await api('/api/products')).products.find(x => String(x.id) === String(id));
  const m = modal(`<h3>${id ? 'Edit' : 'New'} product</h3>
    <label>SKU*<input id="f-sku" value="${esc(p.sku)}"></label><label>Name*<input id="f-name" value="${esc(p.name)}"></label>
    <label>Description<input id="f-desc" value="${esc(p.description || '')}"></label>
    <div class="grid cols2"><label>Price<input id="f-price" type="number" step="0.01" value="${p.price}"></label><label>Tax %<input id="f-tax" type="number" step="0.01" value="${p.tax}"></label></div>
    <label><input type="checkbox" id="f-act" ${p.active ? 'checked' : ''} style="width:auto"> Active</label>
    <div class="flex mt"><button class="btn primary" id="f-save">Save</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
  m.querySelector('#f-save').onclick = async () => {
    const body = JSON.stringify({ sku: m.querySelector('#f-sku').value, name: m.querySelector('#f-name').value, description: m.querySelector('#f-desc').value, price: +m.querySelector('#f-price').value, tax: +m.querySelector('#f-tax').value, active: m.querySelector('#f-act').checked });
    try { id ? await api('/api/products/' + id, { method: 'PUT', body }) : await api('/api/products', { method: 'POST', body }); closeModal(); toast('Saved', 'ok'); vProducts(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

// ---------- PAYMENTS ----------
async function vPayments() {
  const { payments } = await api('/api/payments');
  $('#view').innerHTML = `<div class="card"><h3>All payments (${payments.length})</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Amount</th><th>Method</th><th>Ref</th><th>By</th></tr></thead>
    <tbody>${payments.map(p => `<tr style="cursor:pointer" onclick="go('invoice',{id:'${p.invoice_id}'})"><td>${esc(p.payment_date)}</td><td><b>${esc(p.invoice_number)}</b></td><td>${esc(p.cust_name || '')}</td><td>${inr(p.amount)}</td><td>${esc(p.method)}</td><td>${esc(p.reference || '')}</td><td>${esc(p.recorded_by_name || '')}</td></tr>`).join('') || '<tr><td colspan=7>No payments</td></tr>'}</tbody></table></div></div>`;
}

// ---------- REPORTS ----------
async function vReports() {
  $('#view').innerHTML = `<div class="toolbar"><input type="date" id="r-from"><input type="date" id="r-to"><button class="btn sm primary" id="r-go">Run</button>
    <button class="btn sm ghost" id="r-csv">Export CSV</button></div><div id="r-out"></div>`;
  let last = null;
  $('#r-go').onclick = async () => {
    const p = new URLSearchParams({ from: $('#r-from').value, to: $('#r-to').value });
    last = await api('/api/reports/summary?' + p);
    $('#r-out').innerHTML = `<div class="grid cols3">
      <div class="card kpi"><div class="v">${last.invoices.n}</div><div class="l">Invoices • ${inr(last.invoices.total)}</div></div>
      <div class="card kpi"><div class="v">${inr(last.payments.total)}</div><div class="l">Collected (${last.payments.count})</div></div>
      <div class="card kpi"><div class="v">${inr(last.outstanding)}</div><div class="l">Outstanding</div></div></div>
      <div class="grid cols2 mt"><div class="card"><h3>By payment method</h3><table>${last.byMethod.map(m => `<tr><td>${esc(m.method)}</td><td>${m.n}</td><td style="text-align:right">${inr(m.t)}</td></tr>`).join('') || '<tr><td>None</td></tr>'}</table></div>
      <div class="card"><h3>By staff</h3><table>${last.byStaff.map(s => `<tr><td>${esc(s.name || '-')}</td><td>${s.n}</td><td style="text-align:right">${inr(s.t)}</td></tr>`).join('')}</table></div></div>`;
  };
  $('#r-csv').onclick = async () => {
    const { invoices } = await api('/api/invoices?sort=newest');
    const csv = 'invoice,customer,date,due,total,paid,outstanding,status\n' + invoices.map(i => [i.invoice_number, `"${(i.cust_name || '').replace(/"/g, '')}"`, i.invoice_date, i.due_date, i.total, i.paid, i.outstanding, i.status].join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'invoices.csv'; a.click();
  };
}

// ---------- STAFF ----------
async function vStaff() {
  const { users } = await api('/api/staff');
  $('#view').innerHTML = `<button class="btn primary sm mb" id="s-add">+ Staff member</button>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.active ? 'Yes' : 'No'}</td>
    <td><button class="btn sm ghost" onclick="staffEdit('${u.id}','${esc(u.name)}','${esc(u.role)}',${u.active})">Edit</button></td></tr>`).join('')}</tbody></table></div>
    <p class="small muted mt">Roles — Admin: everything including staff, reports & database reset. Accountant: invoices, payments, customers, audit. Staff: invoices, customers, products, payments (no reports, staff, audit or reset). Enforced server-side.</p>`;
  $('#s-add').onclick = () => staffEdit(null);
}
window.staffEdit = (id, name = '', role = 'staff', active = 1) => {
  const m = modal(`<h3>${id ? 'Edit' : 'New'} staff</h3>
    ${id ? '' : '<label>Name<input id="s-name" value=""></label><label>Email<input id="s-email"></label><label>Password<input id="s-pass" type="password"></label>'}
    ${id ? `<p><b>${esc(name)}</b></p>` : ''}
    <label>Role<select id="s-role"><option ${role === 'staff' ? 'selected' : ''}>staff</option><option ${role === 'accountant' ? 'selected' : ''}>accountant</option><option ${role === 'admin' ? 'selected' : ''}>admin</option></select></label>
    ${id ? `<label><input type="checkbox" id="s-act" ${active ? 'checked' : ''} style="width:auto"> Active</label><label>Reset password<input id="s-pass" type="password" placeholder="(leave blank to keep)"></label>` : ''}
    <div class="flex mt"><button class="btn primary" id="s-save">Save</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
  m.querySelector('#s-save').onclick = async () => {
    try {
      if (!id) await api('/api/staff', { method: 'POST', body: JSON.stringify({ name: m.querySelector('#s-name').value, email: m.querySelector('#s-email').value, password: m.querySelector('#s-pass').value, role: m.querySelector('#s-role').value }) });
      else {
        const body = { role: m.querySelector('#s-role').value, active: m.querySelector('#s-act').checked };
        if (m.querySelector('#s-pass').value) body.password = m.querySelector('#s-pass').value;
        await api('/api/staff/' + id, { method: 'PUT', body: JSON.stringify(body) });
      }
      closeModal(); toast('Saved', 'ok'); vStaff();
    } catch (e) { toast(e.message, 'err'); }
  };
};

// ---------- SETTINGS (business + static QR) ----------
async function vSettings() {
  $('#view').innerHTML = '<p>Loading…</p>';
  const { business: b, qrConfigured } = await api('/api/business');
  $('#view').innerHTML = `
    <div class="grid cols2">
    <div class="card"><h3>Business identity</h3>
      <label>Business name*<input id="b-name" value="${esc(b.business_name || '')}"></label>
      <label>Legal name<input id="b-legal" value="${esc(b.legal_name || '')}"></label>
      <div class="grid cols2"><label>GSTIN<input id="b-gst" value="${esc(b.gstin || '')}"></label><label>PAN<input id="b-pan" value="${esc(b.pan || '')}"></label></div>
      <label>Website<input id="b-web" value="${esc(b.website || '')}"></label>
      <label>Logo (auto-shrunk on upload so PDFs stay light) ${b.logo_path ? `<img src="/${esc(b.logo_path)}" class="qr-preview">` : '<span class="muted small">none</span>'}<input type="file" id="b-logo" accept="image/*"></label>
      <div class="grid cols2"><label>Phone<input id="b-phone" value="${esc(b.phone || '')}"></label><label>Alt phone<input id="b-alt" value="${esc(b.alt_phone || '')}"></label></div>
      <label>Email<input id="b-email" value="${esc(b.email || '')}"></label><label>WhatsApp<input id="b-wa" value="${esc(b.whatsapp || '')}"></label>
      <label>Address 1<input id="b-a1" value="${esc(b.addr1 || '')}"></label><label>Address 2<input id="b-a2" value="${esc(b.addr2 || '')}"></label>
      <div class="grid cols2"><label>City<input id="b-city" value="${esc(b.city || '')}"></label><label>State<input id="b-state" value="${esc(b.state || '')}"></label></div>
      <div class="grid cols2"><label>PIN<input id="b-pin" value="${esc(b.pin || '')}"></label><label>Country<input id="b-country" value="${esc(b.country || 'India')}"></label></div>
    </div>
    <div>
    <div class="card"><h3>Payment settings — static business QR (never auto-generated)</h3>
      ${qrConfigured ? `<img src="/${esc(b.qr_image_path)}?t=${Date.now()}" class="qr-preview"><p class="small muted">Current uploaded QR. Same image reused on all invoices.</p>`
        : `<div class="warn">⚠ No payment QR uploaded. Nothing will be auto-generated. Upload one below, or keep “Show QR” OFF.</div>`}
      <label>Upload / replace QR image<input type="file" id="b-qr" accept="image/*"></label>
      <div class="flex"><button class="btn sm primary" id="qr-up">Upload QR</button>
      ${qrConfigured ? '<button class="btn sm danger" id="qr-del">Remove QR</button>' : ''}</div>
      <label class="mt"><input type="checkbox" id="b-showqr" ${b.show_qr ? 'checked' : ''} style="width:auto"> <b>Show Payment QR on Invoice [ON/OFF]</b></label>
      <p class="small muted">ON → uploaded image appears in the QR area of the PDF (aspect preserved). OFF → QR section hidden. If no QR uploaded, nothing is generated — an empty-state warning is shown instead.</p>
      <div class="grid cols2"><label>UPI ID<input id="b-upi" value="${esc(b.upi_id || '')}"></label><label>Bank<input id="b-bank" value="${esc(b.bank_name || '')}"></label></div>
      <label>A/c holder<input id="b-holder" value="${esc(b.account_holder || '')}"></label>
      <div class="grid cols2"><label>A/c number<input id="b-ac" value="${esc(b.account_number || '')}"></label><label>IFSC<input id="b-ifsc" value="${esc(b.ifsc || '')}"></label></div>
    </div>
    <div class="card mt"><h3>Invoice settings</h3>
      <div class="grid cols2"><label>Prefix<input id="b-prefix" value="${esc(b.invoice_prefix || 'INV-')}"></label><label>Next number<input id="b-next" type="number" min="1" value="${b.next_invoice_number}"></label></div>
      <div class="grid cols2"><label>Currency<input id="b-cur" value="${esc(b.currency || '₹')}"></label><label>Default tax %<input id="b-tax" type="number" step="0.01" value="${b.default_tax || 0}"></label></div>
      <label>Payment terms<input id="b-pterms" value="${esc(b.default_payment_terms || '')}"></label>
      <label>Default notes<textarea id="b-notes">${esc(b.default_notes || '')}</textarea></label>
      <label>Default terms<textarea id="b-terms">${esc(b.default_terms || '')}</textarea></label>
      <button class="btn primary" id="b-save">Save all settings</button>
    </div>
    <div class="card mt danger-zone"><h3>⚠ Danger zone — admin only</h3>
      <p class="small">Reset wipes <b>all</b> invoices, customers, products, payments, staff (except you)
      and uploaded files, then restores factory defaults. A timestamped backup of the
      database is saved automatically before wiping.</p>
      <div class="flex"><button class="btn sm danger" id="db-reset">Reset entire database…</button></div>
      <div id="backup-list" class="mt"><p class="small muted">Loading backups…</p></div>
    </div></div></div>`;

  const val = id => $(id).value;
  $('#b-save').onclick = async () => {
    try {
      await api('/api/business', { method: 'PUT', body: JSON.stringify({
        business_name: val('#b-name'), legal_name: val('#b-legal'), gstin: val('#b-gst'), pan: val('#b-pan'), website: val('#b-web'),
        phone: val('#b-phone'), alt_phone: val('#b-alt'), email: val('#b-email'), whatsapp: val('#b-wa'),
        addr1: val('#b-a1'), addr2: val('#b-a2'), city: val('#b-city'), state: val('#b-state'), pin: val('#b-pin'), country: val('#b-country'),
        upi_id: val('#b-upi'), bank_name: val('#b-bank'), account_holder: val('#b-holder'), account_number: val('#b-ac'), ifsc: val('#b-ifsc'),
        invoice_prefix: val('#b-prefix'), next_invoice_number: +val('#b-next'), currency: val('#b-cur'), default_tax: +val('#b-tax'),
        default_payment_terms: val('#b-pterms'), default_notes: val('#b-notes'), default_terms: val('#b-terms'),
        show_qr: $('#b-showqr').checked ? 1 : 0 }) });
      const lf = $('#b-logo').files[0];
      if (lf) { const fd = new FormData(); fd.append('image', await processImage(lf, 512), lf.name); await apiForm('/api/business/assets/logo', fd); }
      toast('Business settings saved', 'ok'); refreshQrBadge(); vSettings();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#qr-up').onclick = async () => {
    const f = $('#b-qr').files[0];
    if (!f) return toast('Choose an image first', 'err');
    try { const fd = new FormData(); fd.append('image', await processImage(f, 1024), f.name); await apiForm('/api/business/assets/qr', fd); toast('QR uploaded — will appear on new invoices', 'ok'); refreshQrBadge(); vSettings(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const qd = $('#qr-del');
  if (qd) qd.onclick = async () => {
    if (!confirm('Remove the business QR? New invoices will show no QR.')) return;
    await api('/api/business/assets/qr', { method: 'DELETE' }); toast('QR removed', 'ok'); refreshQrBadge(); vSettings();
  };

  const loadBackups = async () => {
    try {
      const { backups } = await api('/api/admin/backups');
      $('#backup-list').innerHTML = `<h3 class="mt">Database backups (${backups.length})</h3>` +
        (backups.map(x => `<div class="flex" style="justify-content:space-between;border-top:1px solid var(--line);padding:6px 0">
          <span class="small"><b>${esc(x.name)}</b><br><span class="muted">${(x.size / 1024).toFixed(0)} KB • ${esc(new Date(x.created).toLocaleString())}</span></span>
          <a class="btn sm ghost" href="/api/admin/backups/${encodeURIComponent(x.name)}" onclick="return dlBackup(event,'${esc(x.name)}')">Download</a></div>`).join('') || '<p class="small muted">No backups yet.</p>');
    } catch { $('#backup-list').innerHTML = '<p class="small muted">Backups unavailable.</p>'; }
  };
  loadBackups();

  $('#db-reset').onclick = () => {
    const m = modal(`<h3>Reset entire database?</h3>
      <div class="warn">This deletes <b>all</b> invoices, customers, products, payments, other staff
      accounts and uploaded files. A backup copy is saved first. This cannot be undone.</div>
      <label>Type <b>RESET</b> to confirm<input id="rz-text" placeholder="RESET" autocomplete="off"></label>
      <div class="flex mt"><button class="btn danger" id="rz-go" disabled>Reset everything</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
    const inp = m.querySelector('#rz-text'), go = m.querySelector('#rz-go');
    inp.oninput = () => go.disabled = inp.value.trim() !== 'RESET';
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Resetting…';
      try {
        const r = await api('/api/admin/reset-database', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) });
        closeModal(); toast(`Database reset. Backup: ${r.backup}`, 'ok');
        refreshQrBadge(); go('dashboard');
      } catch (e) { toast(e.message, 'err'); go.disabled = false; go.textContent = 'Reset everything'; }
    };
  };
}

async function vAudit() {
  const { logs } = await api('/api/audit');
  $('#view').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>ID</th><th>Meta</th></tr></thead>
    <tbody>${logs.map(l => `<tr><td class="small">${esc(l.created_at)}</td><td>${esc(l.user_name)}</td><td><b>${esc(l.action)}</b></td><td>${esc(l.entity)}</td><td>${esc(l.entity_id)}</td><td class="small muted">${esc((l.meta || '').slice(0, 120))}</td></tr>`).join('')}</tbody></table></div>`;
}

async function refreshQrBadge() {
  try {
    const { business } = await api('/api/business');
    state.business = business;
    $('#qr-badge').innerHTML = business.show_qr ? (business.qr_image_path ? '🟣 QR: ON + uploaded' : '⚠ QR: ON, none uploaded') : 'QR: OFF';
  } catch {}
}

// ---------- boot ----------
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#login-email').value, password: $('#login-password').value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    state.token = j.token; localStorage.setItem('token', j.token); state.user = j.user;
    enter();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout-btn').onclick = () => { localStorage.removeItem('token'); location.reload(); };
$('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
$('#side-close').onclick = () => $('#sidebar').classList.remove('open');

async function enter() {
  $('#login-view').classList.add('hidden'); $('#app').classList.remove('hidden');
  renderNav(); await refreshQrBadge(); go('dashboard');
}
(async () => {
  try {
    if (sessionStorage.getItem('session_expired')) {
      sessionStorage.removeItem('session_expired');
      const e = document.querySelector('#login-error');
      if (e) e.textContent = 'Session expired — please log in again.';
    }
  } catch {}
  if (!state.token) return;
  try {
    const m = await api('/api/auth/me');
    state.user = m.user; enter();
  } catch { localStorage.removeItem('token'); state.token = ''; }
})();
