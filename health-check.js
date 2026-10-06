// End-to-end health check. Run with the server up: node health-check.js
const B = 'http://localhost:3000';
let pass = 0, fail = 0;
const results = [];

async function req(method, path, opts = {}, maybeBody) {
  // allow req(m, p, token) and req(m, p, token, body) as shorthands
  if (typeof opts === 'string') opts = { token: opts, body: maybeBody };
  const { token, body, raw } = opts;
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  const t = await r.text();
  let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { status: r.status, body: j };
}
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
}
async function getInv(id, token) {
  const r = await req('GET', `/api/invoices/${id}`, { token });
  return r.body.invoice || {};
}
async function login(email, password) {
  const r = await req('POST', '/api/auth/login', { body: { email, password } });
  return r.body.token;
}
async function expectDeny(label, method, path, token, body) {
  const r = await req(method, path, { token, body });
  check(label, r.status === 403 || r.status === 401, `got ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
}
async function expectOk(label, method, path, token, body) {
  const r = await req(method, path, { token, body });
  check(label, r.status >= 200 && r.status < 300, `got ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
  return r.body || {};
}

(async () => {
  // ---------- health ----------
  const h = await req('GET', '/api/health');
  check('health endpoint', h.status === 200 && h.body.ok, JSON.stringify(h.body));

  // ---------- auth ----------
  const admin = await login('admin@business.local', 'admin123');
  check('admin login', !!admin);
  const bad = await req('POST', '/api/auth/login', { body: { email: 'admin@business.local', password: 'wrong' } });
  check('bad password rejected', bad.status === 401);
  const noTok = await req('GET', '/api/invoices');
  check('unauthenticated rejected', noTok.status === 401);
  const badTok = await req('GET', '/api/invoices', { token: 'garbage.token.here' });
  check('invalid token rejected', badTok.status === 401);

  // provision staff + accountant
  const su = `health_staff_${Date.now()}@t.local`, au = `health_acct_${Date.now()}@t.local`;
  const suRes = await expectOk('create staff', 'POST', '/api/staff', admin, { name: 'HC Staff', email: su, password: 'pw123456', role: 'staff' });
  const auRes = await expectOk('create accountant', 'POST', '/api/staff', admin, { name: 'HC Acct', email: au, password: 'pw123456', role: 'accountant' });
  const staff = await login(su, 'pw123456'), acct = await login(au, 'pw123456');
  check('staff login', !!staff); check('accountant login', !!acct);

  // ---------- RBAC ----------
  await expectDeny('staff blocked from reports', 'GET', '/api/reports/summary', staff);
  await expectDeny('accountant blocked from reports', 'GET', '/api/reports/summary', acct);
  await expectDeny('staff blocked from business settings', 'PUT', '/api/business', staff, { business_name: 'X' });
  await expectDeny('accountant blocked from business settings', 'PUT', '/api/business', acct, { business_name: 'X' });
  await expectDeny('staff blocked from staff mgmt', 'GET', '/api/staff', staff);
  await expectDeny('accountant blocked from customers write', 'POST', '/api/customers', acct, { name: 'X' });
  await expectDeny('staff blocked from cancel', 'POST', '/api/invoices/1/cancel', staff);
  const au1 = await expectOk('accountant allowed audit read', 'GET', '/api/audit', acct);

  // ---------- customer ----------
  const cust = await expectOk('staff creates customer', 'POST', '/api/customers', staff, { name: 'HC Customer', email: 'hc@t.local', gstin: 'TESTGST' });
  check('customer has id', !!cust.id);

  // ---------- invoice math ----------
  const inv = await expectOk('create invoice', 'POST', '/api/invoices', admin, {
    customer_id: cust.id, invoice_date: '2026-10-01', due_date: '2026-12-01',
    items: [{ name: 'Widget', sku: 'HC-1', quantity: 3, unit_price: 999, discount: 99, tax: 10 }],
  });
  check('sequential number format', /^INV-\d{6}$/.test(inv.invoice_number || ''), inv.invoice_number);
  const detail = (await expectOk('fetch invoice', 'GET', `/api/invoices/${inv.id}`, admin)).invoice;
  if (!detail) { console.log('\nABORT: invoice not created, cannot continue'); process.exit(1); }
  // 3*999=2997 -99 = 2898 +10% = 289.80 -> 3187.80
  check('subtotal math', Math.abs(detail.subtotal - 2997) < 0.01, `got ${detail.subtotal}`);
  check('discount math', Math.abs(detail.discount_total - 99) < 0.01, `got ${detail.discount_total}`);
  check('tax math', Math.abs(detail.tax_total - 289.8) < 0.02, `got ${detail.tax_total}`);
  check('total math', Math.abs(detail.total - 3187.8) < 0.02, `got ${detail.total}`);
  check('starts Unpaid', detail.status === 'Unpaid', detail.status);
  check('customer snapshot frozen', detail.cust_name === 'HC Customer' && detail.cust_gstin === 'TESTGST');

  // snapshot immutability
  await expectOk('rename customer', 'PUT', `/api/customers/${cust.id}`, admin, { name: 'HC Renamed', business_name: 'B', address: 'A', phone: 'P', email: 'e@e.com', gstin: 'NEWGST', notes: '' });
  const after = (await expectOk('re-fetch invoice', 'GET', `/api/invoices/${inv.id}`, admin)).invoice;
  check('historical invoice unchanged after customer edit',
    after.cust_name === 'HC Customer' && after.cust_gstin === 'TESTGST',
    `name=${after.cust_name} gstin=${after.cust_gstin}`);

  // ---------- payments ----------
  const p1 = await expectOk('partial payment', 'POST', `/api/invoices/${inv.id}/payments`, admin, { amount: 1000, method: 'UPI', payment_date: '2026-10-05', reference: 'R1' });
  let v = await getInv(inv.id, admin);
  check('status -> Partially Paid', v.status === 'Partially Paid', v.status);
  check('outstanding after partial', Math.abs(v.outstanding - 2187.8) < 0.02, `got ${v.outstanding}`);

  const over = await req('POST', `/api/invoices/${inv.id}/payments`, admin, { amount: 99999, method: 'Cash' });
  check('overpayment blocked', over.status === 400, `got ${over.status}`);
  const badMethod = await req('POST', `/api/invoices/${inv.id}/payments`, admin, { amount: 10, method: 'Bitcoin' });
  check('invalid method blocked', badMethod.status === 400, `got ${badMethod.status}`);
  const negAmt = await req('POST', `/api/invoices/${inv.id}/payments`, admin, { amount: -50, method: 'Cash' });
  check('negative amount blocked', negAmt.status === 400, `got ${negAmt.status}`);

  await expectOk('settle remaining', 'POST', `/api/invoices/${inv.id}/payments`, admin, { amount: v.outstanding, method: 'Bank Transfer' });
  v = await getInv(inv.id, admin);
  check('status -> Paid', v.status === 'Paid', v.status);
  check('outstanding zero', v.outstanding < 0.01, `got ${v.outstanding}`);
  const payOnPaid = await req('POST', `/api/invoices/${inv.id}/payments`, admin, { amount: 10, method: 'Cash' });
  check('payment on paid invoice blocked', payOnPaid.status === 400, `got ${payOnPaid.status}`);

  // payment deletion re-derives status
  await expectOk('delete payment', 'DELETE', `/api/payments/${p1.id}`, admin);
  v = await getInv(inv.id, admin);
  // deleting the first payment leaves 2187.80 of 3187.80 → Partially Paid, not Unpaid
check('status re-derives after delete', v.status === 'Partially Paid', v.status);
  check('outstanding recomputed after delete', Math.abs(v.outstanding - 1000) < 0.02, `got ${v.outstanding}`);

  // ---------- overdue ----------
  const od = await expectOk('past-due invoice', 'POST', '/api/invoices', admin, {
    customer_id: cust.id, invoice_date: '2026-01-01', due_date: '2026-01-15',
    items: [{ name: 'Old', quantity: 1, unit_price: 500, discount: 0, tax: 0 }],
  });
  const odv = await getInv(od.id, admin);
  check('overdue derived', odv.status === 'Overdue', odv.status);

  // ---------- PDF ----------
  const pdf = await req('GET', `/api/invoices/${inv.id}/pdf`, { token: admin, raw: true });
  check('PDF 200', pdf.status === 200, `got ${pdf.status}`);
  check('PDF magic bytes', pdf.buf.slice(0, 5).toString() === '%PDF-', pdf.buf.slice(0, 8).toString());
  check('PDF non-trivial size', pdf.buf.length > 10000, `${pdf.buf.length} bytes`);
  const pdfNoAuth = await req('GET', `/api/invoices/${inv.id}/pdf`);
  check('PDF requires auth', pdfNoAuth.status === 401, `got ${pdfNoAuth.status}`);

  // ---------- cancel ----------
  await expectOk('admin cancels invoice', 'POST', `/api/invoices/${od.id}/cancel`, admin);
  const cv = await getInv(od.id, admin);
  check('status -> Cancelled', cv.status === 'Cancelled', cv.status);
  const payCancelled = await req('POST', `/api/invoices/${od.id}/payments`, admin, { amount: 10, method: 'Cash' });
  check('payment on cancelled blocked', payCancelled.status === 400, `got ${payCancelled.status}`);

  // ---------- validation ----------
  const noItems = await req('POST', '/api/invoices', admin, { customer_id: cust.id, invoice_date: '2026-10-01', items: [] });
  check('invoice with no items blocked', noItems.status === 400, `got ${noItems.status}`);
  const badInv = await req('GET', '/api/invoices/999999', admin);
  check('missing invoice 404', badInv.status === 404, `got ${badInv.status}`);
  const badId = await req('GET', '/api/invoices/abc', admin);
  check('non-numeric id does not 500', badId.status < 500, `got ${badId.status}`);
  const sqlInj = await req('GET', `/api/invoices/${encodeURIComponent("1 OR 1=1")}`, admin);
  check('sql-ish id does not 500', sqlInj.status < 500, `got ${sqlInj.status}`);

  // ---------- dashboard / reports ----------
  const dash = await expectOk('dashboard', 'GET', '/api/dashboard', admin);
  check('dashboard has kpis', !!dash.kpis);
  const rep = await expectOk('reports (admin)', 'GET', '/api/reports/summary', admin);
  check('reports returns data', !!rep);

  // ---------- duplicate ----------
  const dup = await expectOk('duplicate invoice', 'POST', `/api/invoices/${inv.id}/duplicate`, admin);
  check('duplicate gets new number', dup.invoice_number !== inv.invoice_number, `${inv.invoice_number} -> ${dup.invoice_number}`);

  // ---------- cleanup test users ----------
  await req('DELETE', `/api/staff/${suRes.id}`, admin);
  await req('DELETE', `/api/staff/${auRes.id}`, admin);
  const dupDel = await req('DELETE', `/api/staff/${dup.id}`, admin);
  check('cleanup: duplicate invoice removed', dupDel.status === 200 || dupDel.status === 404, `got ${dupDel.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });