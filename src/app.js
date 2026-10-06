const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { NODE_ENV, PORT, DATA_DIR, JWT_SECRET } = require('./config');
const store = require('./store');
const { getStorage } = require('./storage');
const { generateInvoicePDF } = require('./pdf');

const storage = getStorage();
const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // The SPA wires actions with inline onclick="..." attributes. Helmet
      // defaults script-src-attr to 'none', which silently blocks every one of
      // them (buttons render but do nothing). Allow attribute handlers while
      // keeping script-src 'self', so inline <script> blocks stay blocked.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts, try again later' } });
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
if (storage.kind === 'local') {
  app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));
}

// Ensure seeds exist before serving (idempotent; covers cold starts).
let _ready = false;
app.use(async (req, res, next) => {
  try {
    if (!_ready) { await store.init(); _ready = true; }
    next();
  } catch (e) { next(e); }
});

// async handler wrapper (Express 4 doesn't catch async rejections)
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------
const S = v => (v === undefined || v === null ? '' : String(v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '12h' });
}

const requireAuth = ah(async (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const u = await store.getUser(p.id);
    if (!u || !u.active) return res.status(401).json({ error: 'Account disabled' });
    req.user = { id: u.id, name: u.name, email: u.email, role: u.role };
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
});

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden: insufficient permission' });
    next();
  };
}

const CAN = {
  businessWrite: u => u.role === 'admin',
  invoiceCreate: u => ['admin', 'staff', 'accountant'].includes(u.role),
  invoiceEdit: u => ['admin', 'staff'].includes(u.role),
  invoiceCancel: u => u.role === 'admin',
  paymentWrite: u => ['admin', 'staff', 'accountant'].includes(u.role),
  customerWrite: u => ['admin', 'staff'].includes(u.role),
  productWrite: u => ['admin', 'staff'].includes(u.role),
};

async function audit({ user, action, entity = '', entity_id = '', meta = '' }) {
  try {
    await store.addAudit({
      user_id: user ? user.id : null,
      user_name: user ? user.name : 'system',
      action, entity, entity_id: S(entity_id),
      meta: typeof meta === 'string' ? meta : JSON.stringify(meta),
    });
  } catch (e) { console.error('audit fail', e.message); }
}

function calcTotals(items, defaultTax) {
  let subtotal = 0, discount = 0, tax = 0;
  const out = items.map(it => {
    const qty = num(it.quantity), price = num(it.unit_price);
    const disc = num(it.discount), tx = (it.tax === undefined || it.tax === '' || it.tax === null) ? num(defaultTax) : num(it.tax);
    const line = qty * price - disc;
    const lineTax = line * tx / 100;
    subtotal += qty * price; discount += disc; tax += lineTax;
    return { ...it, quantity: qty, unit_price: price, discount: disc, tax: tx, total: Math.round((line + lineTax) * 100) / 100 };
  });
  subtotal = Math.round(subtotal * 100) / 100;
  discount = Math.round(discount * 100) / 100;
  tax = Math.round(tax * 100) / 100;
  const total = Math.round((subtotal - discount + tax) * 100) / 100;
  return { items: out, subtotal, discount_total: discount, tax_total: tax, total };
}

function computeStatus(invoice, paid) {
  if (invoice.status === 'Cancelled') return 'Cancelled';
  const total = num(invoice.total);
  if (paid >= total && total > 0) return 'Paid';
  if (invoice.due_date) {
    const today = new Date().toISOString().slice(0, 10);
    if (invoice.due_date < today && (total - paid) > 0.005) return 'Overdue';
  }
  if (paid <= 0.005) return 'Unpaid';
  if (paid < total - 0.005) return 'Partially Paid';
  return 'Paid';
}

async function userMap() {
  const users = await store.listUsers();
  return new Map(users.map(u => [S(u.id), u.name || '-']));
}

// Enriched invoice view: items, payments, paid/outstanding, live status.
async function invoiceView(id) {
  const inv = await store.getInvoice(id);
  if (!inv) return null;
  const [items, payments, umap] = await Promise.all([
    store.getInvoiceItems(id), store.listPayments().then(ps => ps.filter(p => S(p.invoice_id) === S(id)).sort((a, b) => (a.payment_date < b.payment_date ? -1 : 1))),
    userMap(),
  ]);
  const paid = payments.reduce((s, p) => s + num(p.amount), 0);
  let status = inv.status;
  if (status !== 'Cancelled') {
    const s = computeStatus(inv, paid);
    if (s !== status) { await store.updateInvoice(id, { status: s }); status = s; }
  }
  return {
    invoice: { ...inv, status, paid, outstanding: Math.max(0, num(inv.total) - paid), created_by_name: umap.get(S(inv.created_by)) || '-' },
    items,
    payments: payments.map(p => ({ ...p, recorded_by_name: umap.get(S(p.recorded_by)) || '-' })),
  };
}

async function enrichInvoices(rows) {
  const [payments, users] = await Promise.all([store.listPayments(), store.listUsers()]);
  const umap = new Map(users.map(u => [S(u.id), u.name || '-']));
  const byInv = new Map();
  for (const p of payments) {
    const k = S(p.invoice_id);
    if (!byInv.has(k)) byInv.set(k, []);
    byInv.get(k).push(p);
  }
  return rows.map(r => {
    const ps = byInv.get(S(r.id)) || [];
    const paid = ps.reduce((s, p) => s + num(p.amount), 0);
    return { ...r, paid, outstanding: Math.max(0, num(r.total) - paid), computed_status: computeStatus(r, paid), created_by_name: umap.get(S(r.created_by)) || '-' };
  });
}

// ---------- health ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), env: NODE_ENV, backend: store.kind }));

// ---------- auth ----------
app.post('/api/auth/login', loginLimiter, ah(async (req, res) => {
  const { email, password } = req.body || {};
  const u = await store.findUserByEmail(email);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  if (!u.active) return res.status(403).json({ error: 'Account disabled' });
  audit({ user: u, action: 'login', entity: 'user', entity_id: u.id });
  res.json({ token: sign(u), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
}));

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

// ---------- uploads ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only images allowed'));
    cb(null, true);
  }
});

// ---------- business ----------
app.get('/api/business', requireAuth, ah(async (req, res) => {
  const b = await store.getBusiness();
  res.json({ business: b, qrConfigured: !!b.qr_image_path });
}));

app.put('/api/business', requireAuth, ah(async (req, res) => {
  if (!CAN.businessWrite(req.user)) return res.status(403).json({ error: 'Only admin can update business settings' });
  const allowed = ['business_name', 'legal_name', 'gstin', 'pan', 'website', 'phone', 'alt_phone', 'email', 'whatsapp',
    'addr1', 'addr2', 'city', 'state', 'pin', 'country', 'upi_id', 'bank_name', 'account_holder', 'account_number', 'ifsc',
    'invoice_prefix', 'currency', 'default_tax', 'default_terms', 'default_notes', 'default_payment_terms', 'show_qr'];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  if ('next_invoice_number' in (req.body || {})) {
    if (!Number.isInteger(Number(req.body.next_invoice_number)) || Number(req.body.next_invoice_number) < 1)
      return res.status(400).json({ error: 'Invalid starting invoice number' });
    patch.next_invoice_number = Number(req.body.next_invoice_number);
  }
  if (Object.keys(patch).length) await store.updateBusiness(patch);
  audit({ user: req.user, action: 'business_settings_changed', entity: 'business', entity_id: 1, meta: Object.keys(patch) });
  res.json({ business: await store.getBusiness() });
}));

app.post('/api/business/assets/:kind', requireAuth, upload.single('image'), ah(async (req, res) => {
  if (!CAN.businessWrite(req.user)) return res.status(403).json({ error: 'Only admin can upload assets' });
  const kind = req.params.kind;
  if (!['logo', 'qr'].includes(kind)) return res.status(400).json({ error: 'Invalid asset kind' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const ext = (path.extname(req.file.originalname || '.png').slice(0, 5) || '.png').toLowerCase();
  const rel = `uploads/${kind}-${Date.now()}${ext}`;
  await storage.save(rel, req.file.buffer, req.file.mimetype);
  const biz = await store.getBusiness();
  const col = kind === 'logo' ? 'logo_path' : 'qr_image_path';
  const old = biz[col];
  await store.updateBusiness({ [col]: rel });
  if (old) await storage.del(old);
  audit({ user: req.user, action: kind === 'qr' ? 'qr_uploaded' : 'logo_uploaded', entity: 'business', entity_id: 1, meta: rel });
  res.json({ path: rel, business: await store.getBusiness() });
}));

app.delete('/api/business/assets/:kind', requireAuth, ah(async (req, res) => {
  if (!CAN.businessWrite(req.user)) return res.status(403).json({ error: 'Only admin can remove assets' });
  const kind = req.params.kind;
  const col = kind === 'logo' ? 'logo_path' : kind === 'qr' ? 'qr_image_path' : null;
  if (!col) return res.status(400).json({ error: 'Invalid kind' });
  const old = (await store.getBusiness())[col];
  await store.updateBusiness({ [col]: '' });
  if (old) await storage.del(old);
  audit({ user: req.user, action: kind === 'qr' ? 'qr_removed' : 'logo_removed', entity: 'business', entity_id: 1 });
  res.json({ ok: true });
}));

// Serve uploaded images + generated PDFs from storage (works on every backend)
app.get('/uploads/:name', ah(async (req, res) => {
  const f = await storage.get('uploads/' + path.basename(req.params.name || ''));
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.set('Content-Type', f.contentType).send(f.buffer);
}));

// ---------- staff ----------
app.get('/api/staff', requireAuth, requireRoles('admin'), ah(async (req, res) => {
  const users = await store.listUsers();
  res.json({ users: users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, created_at: u.created_at })) });
}));
app.post('/api/staff', requireAuth, requireRoles('admin'), ah(async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  if (!['admin', 'staff', 'accountant'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const id = await store.createUser({ name, email, password_hash: bcrypt.hashSync(password, 10), role });
    audit({ user: req.user, action: 'staff_created', entity: 'user', entity_id: id });
    res.json({ id });
  } catch { res.status(400).json({ error: 'Email already exists' }); }
}));
app.put('/api/staff/:id', requireAuth, requireRoles('admin'), ah(async (req, res) => {
  const u = await store.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { name, role, active, password } = req.body || {};
  if (role && !['admin', 'staff', 'accountant'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const patch = {};
  if (name) patch.name = name;
  if (role) patch.role = role;
  if (active !== undefined) patch.active = active ? 1 : 0;
  if (password) patch.password_hash = bcrypt.hashSync(password, 10);
  await store.updateUser(u.id, patch);
  audit({ user: req.user, action: 'staff_updated', entity: 'user', entity_id: u.id });
  res.json({ ok: true });
}));
app.delete('/api/staff/:id', requireAuth, requireRoles('admin'), ah(async (req, res) => {
  if (S(req.params.id) === S(req.user.id)) return res.status(400).json({ error: 'Cannot disable yourself' });
  await store.updateUser(req.params.id, { active: 0 });
  audit({ user: req.user, action: 'staff_disabled', entity: 'user', entity_id: req.params.id });
  res.json({ ok: true });
}));

// ---------- admin: database reset + backups (admin only) ----------
app.post('/api/admin/reset-database', requireAuth, requireRoles('admin'), ah(async (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== 'RESET') return res.status(400).json({ error: 'Type RESET to confirm a full database reset' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `data-backup-${stamp}.json`;
  await storage.save(`backups/${backupName}`, Buffer.from(JSON.stringify(await store.exportAll())), 'application/json');
  await storage.clearPrefix('uploads');
  await storage.clearPrefix('invoices');
  await store.factoryReset(req.user.id);
  audit({ user: req.user, action: 'database_reset', entity: 'database', entity_id: backupName });
  res.json({ ok: true, backup: backupName });
}));

app.get('/api/admin/backups', requireAuth, requireRoles('admin'), ah(async (req, res) => {
  const list = (await storage.list('backups')).filter(f => f.name.endsWith('.json'));
  res.json({ backups: list });
}));

app.get('/api/admin/backups/:name', requireAuth, requireRoles('admin'), ah(async (req, res) => {
  const name = path.basename(req.params.name || '');
  if (!name.endsWith('.json')) return res.status(400).json({ error: 'Invalid backup name' });
  const f = await storage.get('backups/' + name);
  if (!f) return res.status(404).json({ error: 'Backup not found' });
  res.set('Content-Type', 'application/json').set('Content-Disposition', `attachment; filename="${name}"`).send(f.buffer);
}));

// ---------- customers ----------
app.get('/api/customers', requireAuth, ah(async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  let rows = await store.listCustomers();
  if (q) rows = rows.filter(c => [c.name, c.business_name, c.phone, c.email].some(v => (v || '').toLowerCase().includes(q)));
  const [invoices, payments] = await Promise.all([store.listInvoices(), store.listPayments()]);
  const withStats = rows.map(c => {
    const invs = invoices.filter(i => S(i.customer_id) === S(c.id) && i.status !== 'Cancelled');
    const ids = new Set(invs.map(i => S(i.id)));
    const paid = payments.filter(p => ids.has(S(p.invoice_id))).reduce((s, p) => s + num(p.amount), 0);
    const total = invs.reduce((s, i) => s + num(i.total), 0);
    return { ...c, total_invoices: invs.length, total_invoiced: total, total_paid: paid, total_outstanding: Math.max(0, total - paid) };
  });
  res.json({ customers: withStats });
}));
app.post('/api/customers', requireAuth, ah(async (req, res) => {
  if (!CAN.customerWrite(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const { name, business_name, address, phone, email, gstin, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Customer name required' });
  const id = await store.createCustomer({ name, business_name: business_name || '', address: address || '', phone: phone || '', email: email || '', gstin: gstin || '', notes: notes || '' });
  audit({ user: req.user, action: 'customer_created', entity: 'customer', entity_id: id });
  res.json({ id });
}));
app.put('/api/customers/:id', requireAuth, ah(async (req, res) => {
  if (!CAN.customerWrite(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const c = await store.getCustomer(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const f = req.body || {};
  await store.updateCustomer(c.id, {
    name: f.name ?? c.name, business_name: f.business_name ?? c.business_name,
    address: f.address ?? c.address, phone: f.phone ?? c.phone, email: f.email ?? c.email,
    gstin: f.gstin ?? c.gstin, notes: f.notes ?? c.notes,
  });
  audit({ user: req.user, action: 'customer_updated', entity: 'customer', entity_id: c.id });
  res.json({ ok: true });
}));
app.delete('/api/customers/:id', requireAuth, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can delete customers' });
  const used = await store.countCustomerInvoices(req.params.id);
  if (used > 0) return res.status(400).json({ error: 'Customer has invoices; cannot delete. Keep for history.' });
  await store.deleteCustomer(req.params.id);
  audit({ user: req.user, action: 'customer_deleted', entity: 'customer', entity_id: req.params.id });
  res.json({ ok: true });
}));
app.get('/api/customers/:id', requireAuth, ah(async (req, res) => {
  const c = await store.getCustomer(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const enriched = await enrichInvoices((await store.listInvoices()).filter(i => S(i.customer_id) === S(c.id)));
  res.json({ customer: c, invoices: enriched });
}));

// ---------- products ----------
app.get('/api/products', requireAuth, ah(async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const onlyActive = req.query.active === '1';
  let rows = await store.listProducts();
  if (onlyActive) rows = rows.filter(p => p.active);
  if (q) rows = rows.filter(p => (p.sku || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q));
  res.json({ products: rows.slice(0, 500) });
}));
app.post('/api/products', requireAuth, ah(async (req, res) => {
  if (!CAN.productWrite(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const { sku, name, description, price, tax, active } = req.body || {};
  if (!sku || !name) return res.status(400).json({ error: 'SKU and name required' });
  try {
    const id = await store.createProduct({ sku, name, description: description || '', price: num(price), tax: num(tax), active: active === false || active === 0 ? 0 : 1 });
    audit({ user: req.user, action: 'product_created', entity: 'product', entity_id: id });
    res.json({ id });
  } catch { res.status(400).json({ error: 'SKU already exists' }); }
}));
app.put('/api/products/:id', requireAuth, ah(async (req, res) => {
  if (!CAN.productWrite(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const p = await store.getProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const f = req.body || {};
  try {
    await store.updateProduct(p.id, {
      sku: f.sku ?? p.sku, name: f.name ?? p.name, description: f.description ?? p.description,
      price: f.price !== undefined ? num(f.price) : num(p.price),
      tax: f.tax !== undefined ? num(f.tax) : num(p.tax),
      active: f.active === undefined ? p.active : (f.active ? 1 : 0),
    });
  } catch { return res.status(400).json({ error: 'SKU already exists' }); }
  audit({ user: req.user, action: 'product_updated', entity: 'product', entity_id: p.id });
  res.json({ ok: true });
}));
app.delete('/api/products/:id', requireAuth, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can deactivate/delete' });
  const used = await store.countProductUsage(req.params.id);
  if (used > 0) {
    await store.updateProduct(req.params.id, { active: 0 });
    return res.json({ ok: true, deactivated: true });
  }
  await store.deleteProduct(req.params.id);
  audit({ user: req.user, action: 'product_deleted', entity: 'product', entity_id: req.params.id });
  res.json({ ok: true });
}));

// ---------- invoices ----------
app.get('/api/invoices', requireAuth, ah(async (req, res) => {
  const { q, status, customer_id, from, to, sort = 'newest', created_by } = req.query;
  let rows = await store.listInvoices();
  // keep derived statuses fresh (same as dashboard)
  const _allPay = await store.listPayments();
  const _paidOf = id => _allPay.filter(p => S(p.invoice_id) === S(id)).reduce((s, p) => s + num(p.amount), 0);
  for (const r of rows) {
    if (r.status === 'Cancelled') continue;
    const st = computeStatus(r, _paidOf(r.id));
    if (st !== r.status) { await store.updateInvoice(r.id, { status: st }); r.status = st; }
  }
  rows = await enrichInvoices(rows);
  if (status && status !== 'All') rows = rows.filter(r => r.status === status);
  if (customer_id) rows = rows.filter(r => S(r.customer_id) === S(customer_id));
  if (created_by) rows = rows.filter(r => S(r.created_by) === S(created_by));
  if (from) rows = rows.filter(r => (r.invoice_date || '') >= from);
  if (to) rows = rows.filter(r => (r.invoice_date || '') <= to);
  if (q) {
    const needle = q.toLowerCase();
    const allItems = await store.listAllItems();
    const byInv = new Map();
    for (const it of allItems) {
      const k = S(it.invoice_id);
      if (!byInv.has(k)) byInv.set(k, []);
      byInv.get(k).push(it);
    }
    rows = rows.filter(r => {
      if ((r.invoice_number + r.cust_name + (r.cust_phone || '')).toLowerCase().includes(needle)) return true;
      return (byInv.get(S(r.id)) || []).some(it => ((it.sku || '') + (it.name || '')).toLowerCase().includes(needle));
    });
  }
  if (sort === 'oldest') rows = rows.slice().reverse();
  else if (sort === 'total_desc') rows = rows.slice().sort((a, b) => b.total - a.total);
  else if (sort === 'total_asc') rows = rows.slice().sort((a, b) => a.total - b.total);
  res.json({ invoices: rows.slice(0, 500) });
}));

app.get('/api/invoices/next-number', requireAuth, ah(async (req, res) => {
  const b = await store.getBusiness();
  res.json({ next: `${b.invoice_prefix}${String(b.next_invoice_number).padStart(6, '0')}` });
}));

app.post('/api/invoices', requireAuth, ah(async (req, res) => {
  if (!CAN.invoiceCreate(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const { customer_id, new_customer, invoice_date, due_date, notes, terms, items, show_qr } = req.body || {};
  if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required' });

  let custId = customer_id || null, custSnap = {};
  if (new_customer && !customer_id) {
    if (!new_customer.name) return res.status(400).json({ error: 'Customer name required' });
    custId = await store.createCustomer({
      name: new_customer.name, business_name: new_customer.business_name || '', address: new_customer.address || '',
      phone: new_customer.phone || '', email: new_customer.email || '', gstin: new_customer.gstin || '', notes: new_customer.notes || '',
    });
  }
  let cust = null;
  if (custId) {
    cust = await store.getCustomer(custId);
    if (!cust) return res.status(400).json({ error: 'Invalid customer' });
    custSnap = { cust_name: cust.name, cust_business: cust.business_name, cust_address: cust.address, cust_phone: cust.phone, cust_email: cust.email, cust_gstin: cust.gstin };
  } else {
    const s = req.body.customer_snapshot || {};
    if (!s.cust_name) return res.status(400).json({ error: 'Customer required' });
    custSnap = { cust_name: s.cust_name, cust_business: s.cust_business || '', cust_address: s.cust_address || '', cust_phone: s.cust_phone || '', cust_email: s.cust_email || '', cust_gstin: s.cust_gstin || '' };
  }

  const biz = await store.getBusiness();
  if (!biz.business_name) return res.status(400).json({ error: 'Business profile incomplete' });

  const wantQR = show_qr === undefined ? !!biz.show_qr : !!show_qr;
  if (wantQR && !biz.qr_image_path) {
    return res.status(400).json({ error: 'Payment QR display is ON but no QR has been uploaded. Upload one in Business Settings or turn Show Payment QR off.', code: 'QR_MISSING' });
  }

  const calc = calcTotals(items, biz.default_tax);
  for (const it of calc.items) if (!it.name) return res.status(400).json({ error: 'Item name required' });
  // optional invoice-level discount (flat ₹ off the whole invoice, on top of per-item discounts)
  const extra = Math.max(0, Math.round(num(req.body.extra_discount) * 100) / 100);
  try {
    const { id, invoice_number, total } = await persistInvoice({
      biz, custId, custSnap, calc, extra, wantQR,
      notes: notes ?? biz.default_notes ?? '', terms: terms ?? biz.default_terms ?? '',
      invoice_date: invoice_date || new Date().toISOString().slice(0, 10), due_date: due_date || null,
      created_by: req.user.id,
    });
    audit({ user: req.user, action: 'invoice_created', entity: 'invoice', entity_id: invoice_number, meta: { id: S(id), total } });
    res.json({ id, invoice_number });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// Shared invoice persistence: totals math, business-QR snapshot (static image
// copied per invoice for historical accuracy), atomic sequential numbering.
async function persistInvoice({ biz, custId, custSnap, calc, extra, wantQR, notes, terms, invoice_date, due_date, created_by }) {
  const discount_total = Math.round((calc.discount_total + extra) * 100) / 100;
  const grand = Math.round((calc.subtotal - discount_total + calc.tax_total) * 100) / 100;
  if (grand <= 0) throw new Error('Invoice total must be > 0');
  let qrSnap = '';
  if (wantQR && biz.qr_image_path) {
    try {
      const ext = (path.extname(biz.qr_image_path).slice(0, 5) || '.png');
      const dest = `invoices/qr-${String(biz.invoice_prefix)}${String(biz.next_invoice_number).padStart(6, '0')}-${Date.now()}${ext}`
        .replace(/[^A-Za-z0-9\-./]/g, '');
      await storage.copy(biz.qr_image_path, dest);
      qrSnap = dest;
    } catch {}
  }
  const bizSnap = JSON.stringify({
    business_name: biz.business_name, phone: biz.phone, email: biz.email,
    addr1: biz.addr1, city: biz.city, state: biz.state, pin: biz.pin, gstin: biz.gstin,
  });
  const { id, invoice_number } = await store.createInvoiceFull({
    customer_id: custId ? S(custId) : null,
    ...custSnap, biz_snapshot: bizSnap,
    invoice_date, due_date: due_date || null,
    subtotal: calc.subtotal, discount_total, tax_total: calc.tax_total, total: grand, extra_discount: extra,
    notes, terms, qr_snapshot_path: qrSnap, show_qr: wantQR ? 1 : 0, created_by: S(created_by),
    items: calc.items.map(it => ({
      product_id: it.product_id ? S(it.product_id) : null, sku: it.sku || '', name: it.name,
      description: it.description || '', quantity: it.quantity, unit_price: it.unit_price,
      discount: it.discount, tax: it.tax, total: it.total,
    })),
  });
  return { id, invoice_number, total: grand };
}

app.post('/api/invoices/:id/duplicate', requireAuth, ah(async (req, res) => {
  if (!CAN.invoiceCreate(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const src = await store.getInvoice(req.params.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  const biz = await store.getBusiness();
  // re-snapshot from the live customer record when it still exists
  let custId = src.customer_id;
  let custSnap = {
    cust_name: src.cust_name, cust_business: src.cust_business, cust_address: src.cust_address,
    cust_phone: src.cust_phone, cust_email: src.cust_email, cust_gstin: src.cust_gstin,
  };
  if (custId) {
    const c = await store.getCustomer(custId);
    if (c) {
      custId = S(c.id);
      custSnap = { cust_name: c.name, cust_business: c.business_name, cust_address: c.address, cust_phone: c.phone, cust_email: c.email, cust_gstin: c.gstin };
    }
  }
  const wantQR = !!src.show_qr;
  if (wantQR && !biz.qr_image_path) {
    return res.status(400).json({ error: 'Payment QR display is ON but no QR has been uploaded. Upload one in Business Settings or turn Show Payment QR off.', code: 'QR_MISSING' });
  }
  const items = await store.getInvoiceItems(src.id);
  if (!items.length) return res.status(400).json({ error: 'Source invoice has no items to duplicate' });
  const calc = calcTotals(items, 0);
  try {
    const r = await persistInvoice({
      biz, custId, custSnap, calc, extra: num(src.extra_discount), wantQR,
      notes: src.notes, terms: src.terms,
      invoice_date: new Date().toISOString().slice(0, 10), due_date: null,
      created_by: req.user.id,
    });
    audit({ user: req.user, action: 'invoice_created', entity: 'invoice', entity_id: r.invoice_number, meta: { id: S(r.id), total: r.total, duplicated_from: src.invoice_number } });
    res.json({ id: r.id, invoice_number: r.invoice_number });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.get('/api/invoices/:id', requireAuth, ah(async (req, res) => {
  const view = await invoiceView(req.params.id);
  if (!view) return res.status(404).json({ error: 'Not found' });
  res.json(view);
}));

app.put('/api/invoices/:id', requireAuth, ah(async (req, res) => {
  if (!CAN.invoiceEdit(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const inv = await store.getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.status === 'Cancelled') return res.status(400).json({ error: 'Cannot edit cancelled invoice' });
  const view = await invoiceView(req.params.id);
  if (view.invoice.paid > 0) return res.status(400).json({ error: 'Cannot edit invoice with recorded payments. Cancel and recreate if needed.' });
  const { invoice_date, due_date, notes, terms, items, extra_discount } = req.body || {};
  const biz = await store.getBusiness();
  const extraOf = (fallback) => extra_discount === undefined ? num(fallback) : Math.max(0, Math.round(num(extra_discount) * 100) / 100);
  // due_date: explicit empty string clears it; omitted key keeps the old value
  const dueOf = ('due_date' in (req.body || {})) ? (due_date || null) : inv.due_date;
  if (items) {
    if (!items.length) return res.status(400).json({ error: 'At least one item required' });
    const calc = calcTotals(items, biz.default_tax);
    const extra = extraOf(inv.extra_discount);
    const discount_total = Math.round((calc.discount_total + extra) * 100) / 100;
    const grand = Math.round((calc.subtotal - discount_total + calc.tax_total) * 100) / 100;
    if (grand <= 0) return res.status(400).json({ error: 'Invoice total must be > 0' });
    await store.updateInvoice(inv.id, {
      invoice_date: invoice_date || inv.invoice_date, due_date: dueOf,
      notes: notes ?? inv.notes, terms: terms ?? inv.terms,
      subtotal: calc.subtotal, discount_total, tax_total: calc.tax_total, total: grand, extra_discount: extra,
    });
    await store.replaceInvoiceItems(inv.id, calc.items);
  } else {
    const patch = {
      invoice_date: invoice_date || inv.invoice_date, due_date: dueOf,
      notes: notes ?? inv.notes, terms: terms ?? inv.terms,
    };
    if (extra_discount !== undefined) {
      const existing = await store.getInvoiceItems(inv.id);
      const c2 = calcTotals(existing, 0);
      const extra = extraOf(inv.extra_discount);
      patch.extra_discount = extra;
      patch.subtotal = c2.subtotal;
      patch.discount_total = Math.round((c2.discount_total + extra) * 100) / 100;
      patch.tax_total = c2.tax_total;
      patch.total = Math.round((c2.subtotal - patch.discount_total + c2.tax_total) * 100) / 100;
      if (patch.total <= 0) return res.status(400).json({ error: 'Invoice total must be > 0' });
    }
    await store.updateInvoice(inv.id, patch);
  }
  audit({ user: req.user, action: 'invoice_edited', entity: 'invoice', entity_id: inv.invoice_number });
  res.json({ ok: true });
}));

app.post('/api/invoices/:id/cancel', requireAuth, ah(async (req, res) => {
  if (!CAN.invoiceCancel(req.user)) return res.status(403).json({ error: 'Only admin can cancel invoices' });
  const inv = await store.getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  await store.updateInvoice(inv.id, { status: 'Cancelled' });
  audit({ user: req.user, action: 'invoice_cancelled', entity: 'invoice', entity_id: inv.invoice_number });
  res.json({ ok: true });
}));

async function writeTemp(buffer, suffix) {
  const p = path.join(os.tmpdir(), `inv-${Date.now()}-${Math.round(Math.random() * 1e6)}${suffix}`);
  fs.writeFileSync(p, buffer);
  return p;
}

// PDF (regenerated fresh on every hit, matching the invoice template)
app.get('/api/invoices/:id/pdf', requireAuth, ah(async (req, res) => {
  const view = await invoiceView(req.params.id);
  if (!view) return res.status(404).json({ error: 'Not found' });
  const { invoice, items, payments } = view;
  const biz = await store.getBusiness();
  let qrTmp = null, logoTmp = null;
  try {
    if (invoice.show_qr) {
      const q = await storage.get(invoice.qr_snapshot_path || biz.qr_image_path || '');
      if (q) qrTmp = await writeTemp(q.buffer, '.png');
    }
    const logoFile = await storage.get(biz.logo_path || '');
    if (logoFile) logoTmp = await writeTemp(logoFile.buffer, '.png');
    const tmp = await writeTemp(Buffer.alloc(0), '.pdf');
    await generateInvoicePDF(invoice, items, biz, null, payments, qrTmp, logoTmp, tmp);
    const pdf = fs.readFileSync(tmp);
    try { fs.unlinkSync(tmp); } catch {}
    await storage.save(`invoices/${invoice.invoice_number}.pdf`, pdf, 'application/pdf');
    res.set('Content-Type', 'application/pdf')
      .set('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`).send(pdf);
  } finally {
    for (const f of [qrTmp, logoTmp]) if (f) try { fs.unlinkSync(f); } catch {}
  }
}));

// ---------- payments ----------
app.post('/api/invoices/:id/payments', requireAuth, ah(async (req, res) => {
  if (!CAN.paymentWrite(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const inv = await store.getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.status === 'Cancelled') return res.status(400).json({ error: 'Cannot record payment on cancelled invoice' });
  const { amount, method, payment_date, reference, note } = req.body || {};
  const amt = num(amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'Amount must be > 0' });
  if (!['UPI', 'Cash', 'Bank Transfer', 'Card', 'Other'].includes(method)) return res.status(400).json({ error: 'Invalid method' });
  const view = await invoiceView(inv.id);
  if (amt - view.invoice.outstanding > 0.005) {
    return res.status(400).json({ error: `Payment exceeds outstanding (${view.invoice.outstanding.toFixed(2)}). Overpayments not allowed.` });
  }
  const id = await store.createPayment({
    invoice_id: S(inv.id), amount: Math.round(amt * 100) / 100, method,
    payment_date: payment_date || new Date().toISOString().slice(0, 10),
    reference: reference || '', note: note || '', recorded_by: S(req.user.id),
  });
  await invoiceView(inv.id); // refresh derived status
  audit({ user: req.user, action: 'payment_recorded', entity: 'payment', entity_id: id, meta: { invoice: inv.invoice_number, amount: amt } });
  res.json({ id });
}));

app.put('/api/payments/:id', requireAuth, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can edit payments' });
  const p = await store.getPayment(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const { amount, method, payment_date, reference, note } = req.body || {};
  await store.updatePayment(p.id, {
    amount: amount !== undefined ? num(amount) : num(p.amount),
    method: method || p.method, payment_date: payment_date || p.payment_date,
    reference: reference ?? p.reference, note: note ?? p.note,
  });
  await invoiceView(p.invoice_id);
  audit({ user: req.user, action: 'payment_edited', entity: 'payment', entity_id: p.id });
  res.json({ ok: true });
}));

app.delete('/api/payments/:id', requireAuth, ah(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can delete payments' });
  const p = await store.getPayment(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  await store.deletePayment(p.id);
  await invoiceView(p.invoice_id);
  audit({ user: req.user, action: 'payment_deleted', entity: 'payment', entity_id: p.id });
  res.json({ ok: true });
}));

app.get('/api/payments', requireAuth, ah(async (req, res) => {
  const [payments, invoices, users] = await Promise.all([store.listPayments(), store.listInvoices(), store.listUsers()]);
  const imap = new Map(invoices.map(i => [S(i.id), i]));
  const umap = new Map(users.map(u => [S(u.id), u.name || '']));
  res.json({
    payments: payments.map(p => ({
      ...p, invoice_number: imap.get(S(p.invoice_id))?.invoice_number || '',
      cust_name: imap.get(S(p.invoice_id))?.cust_name || '',
      recorded_by_name: umap.get(S(p.recorded_by)) || '',
    })),
  });
}));

// ---------- dashboard ----------
app.get('/api/dashboard', requireAuth, ah(async (req, res) => {
  const [invoices, payments, users] = await Promise.all([store.listInvoices(), store.listPayments(), store.listUsers()]);
  const umap = new Map(users.map(u => [S(u.id), u.name || '-']));
  const byInv = new Map();
  for (const p of payments) {
    const k = S(p.invoice_id);
    if (!byInv.has(k)) byInv.set(k, []);
    byInv.get(k).push(p);
  }
  const paidOf = inv => (byInv.get(S(inv.id)) || []).reduce((s, p) => s + num(p.amount), 0);
  // refresh overdue/paid statuses from payment records
  for (const inv of invoices) {
    if (inv.status === 'Cancelled') continue;
    const st = computeStatus(inv, paidOf(inv));
    if (st !== inv.status) { await store.updateInvoice(inv.id, { status: st }); inv.status = st; }
  }
  const live = invoices.filter(i => i.status !== 'Cancelled');
  const totals = live.reduce((s, i) => s + num(i.total), 0);
  const received = payments.filter(p => {
    const inv = invoices.find(i => S(i.id) === S(p.invoice_id));
    return inv && inv.status !== 'Cancelled';
  }).reduce((s, p) => s + num(p.amount), 0);
  const outstanding = Math.max(0, totals - received);

  const byStatus = {};
  for (const s of ['Paid', 'Partially Paid', 'Unpaid', 'Overdue', 'Cancelled']) {
    const rows = invoices.filter(i => i.status === s);
    byStatus[s] = { c: rows.length, t: rows.reduce((x, i) => x + num(i.total), 0) };
  }

  const monthOf = d => (d || '').slice(0, 7);
  const grp = new Map();
  for (const i of live) {
    const m = monthOf(i.invoice_date);
    if (!grp.has(m)) grp.set(m, { m, t: 0, c: 0 });
    grp.get(m).t += num(i.total); grp.get(m).c++;
  }
  const rev = [...grp.values()].sort((a, b) => (a.m < b.m ? -1 : 1)).slice(-12);
  const pgrp = new Map();
  for (const p of payments) {
    const m = monthOf(p.payment_date);
    if (!pgrp.has(m)) pgrp.set(m, { m, t: 0 });
    pgrp.get(m).t += num(p.amount);
  }
  const paidByMonth = [...pgrp.values()].sort((a, b) => (a.m < b.m ? -1 : 1)).slice(-12);

  const cgrp = new Map();
  for (const i of live) {
    const k = i.cust_name || '-';
    if (!cgrp.has(k)) cgrp.set(k, { name: k, total: 0, n: 0 });
    cgrp.get(k).total += num(i.total); cgrp.get(k).n++;
  }
  const topCustomers = [...cgrp.values()].sort((a, b) => b.total - a.total).slice(0, 5);

  const allItems = await store.listAllItems();
  const pgr = new Map();
  for (const it of allItems) {
    const k = `${it.sku || ''}|${it.name || ''}`;
    if (!pgr.has(k)) pgr.set(k, { name: it.name, sku: it.sku, qty: 0, total: 0 });
    pgr.get(k).qty += num(it.quantity); pgr.get(k).total += num(it.total);
  }
  const topProducts = [...pgr.values()].sort((a, b) => b.total - a.total).slice(0, 5);

  const recent = invoices.slice(0, 10).map(r => ({
    ...r, paid: paidOf(r), outstanding: Math.max(0, num(r.total) - paidOf(r)), created_by_name: umap.get(S(r.created_by)) || '-',
  }));
  const overdueAmt = invoices.filter(i => i.status === 'Overdue')
    .reduce((s, i) => s + Math.max(0, num(i.total) - paidOf(i)), 0);

  res.json({
    kpis: { totalInvoices: live.length, totalInvoiced: totals, totalReceived: received, totalOutstanding: outstanding, overdueAmount: overdueAmt, byStatus },
    revenueByMonth: rev, paidByMonth, topCustomers, topProducts, recent,
  });
}));

// ---------- reports (admin only) ----------
app.get('/api/reports/summary', requireAuth, requireRoles('admin'), ah(async (req, res) => {
  const { from, to } = req.query;
  const [invoices, payments, users] = await Promise.all([store.listInvoices(), store.listPayments(), store.listUsers()]);
  const umap = new Map(users.map(u => [S(u.id), u.name || '-']));
  const inv = invoices.filter(i => i.status !== 'Cancelled' && (!from || (i.invoice_date || '') >= from) && (!to || (i.invoice_date || '') <= to));
  const invIds = new Set(inv.map(i => S(i.id)));
  const pay = payments.filter(p => invIds.has(S(p.invoice_id)) && (!from || (p.payment_date || '') >= from) && (!to || (p.payment_date || '') <= to));
  const sub = inv.reduce((s, i) => s + num(i.subtotal), 0), disc = inv.reduce((s, i) => s + num(i.discount_total), 0);
  const tax = inv.reduce((s, i) => s + num(i.tax_total), 0), total = inv.reduce((s, i) => s + num(i.total), 0);
  const ptot = pay.reduce((s, p) => s + num(p.amount), 0);
  const byMethodMap = new Map();
  for (const p of pay) {
    if (!byMethodMap.has(p.method)) byMethodMap.set(p.method, { method: p.method, t: 0, n: 0 });
    byMethodMap.get(p.method).t += num(p.amount); byMethodMap.get(p.method).n++;
  }
  const byStaffMap = new Map();
  for (const i of inv) {
    const k = umap.get(S(i.created_by)) || '-';
    if (!byStaffMap.has(k)) byStaffMap.set(k, { name: umap.get(S(i.created_by)) || null, n: 0, t: 0 });
    byStaffMap.get(k).n++; byStaffMap.get(k).t += num(i.total);
  }
  res.json({
    invoices: { n: inv.length, sub, disc, tax, total },
    payments: { total: ptot, count: pay.length },
    byMethod: [...byMethodMap.values()], byStaff: [...byStaffMap.values()],
    outstanding: total - ptot,
  });
}));

// ---------- audit (admin + accountant only; staff role is blocked) ----------
app.get('/api/audit', requireAuth, requireRoles('admin', 'accountant'), ah(async (req, res) => {
  res.json({ logs: await store.listAudit(200) });
}));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// JSON 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// JSON error handler (keeps async failures clean for the SPA)
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.message === 'Only images allowed') return res.status(400).json({ error: err.message });
  console.error('request failed:', err && err.message);
  res.status(500).json({ error: 'Something went wrong. Please retry.' });
});

module.exports = { app, store, storage };
