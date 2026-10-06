const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { DATA_DIR } = require('./config');

const DB_PATH = path.join(DATA_DIR, 'data.db');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
// node:sqlite helpers to match better-sqlite3 API used in app
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
db.transaction = fn => () => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };
// normalize bigint ids from node:sqlite
const _prep = db.prepare.bind(db);
db.prepare = (sql) => {
  const st = _prep(sql);
  const wrap = (v) => (typeof v === 'bigint' ? Number(v) : v);
  const ow = st.run.bind(st);
  st.run = (...a) => { const r = ow(...a); if (r && typeof r.lastInsertRowid === 'bigint') r.lastInsertRowid = Number(r.lastInsertRowid); return r; };
  return st;
};

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    business_name TEXT DEFAULT 'Your Business',
    legal_name TEXT DEFAULT '',
    logo_path TEXT DEFAULT '',
    gstin TEXT DEFAULT '',
    pan TEXT DEFAULT '',
    website TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    alt_phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    whatsapp TEXT DEFAULT '',
    addr1 TEXT DEFAULT '',
    addr2 TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    pin TEXT DEFAULT '',
    country TEXT DEFAULT 'India',
    upi_id TEXT DEFAULT '',
    bank_name TEXT DEFAULT '',
    account_holder TEXT DEFAULT '',
    account_number TEXT DEFAULT '',
    ifsc TEXT DEFAULT '',
    qr_image_path TEXT DEFAULT '',
    invoice_prefix TEXT DEFAULT 'INV-',
    next_invoice_number INTEGER DEFAULT 1,
    currency TEXT DEFAULT '₹',
    default_tax REAL DEFAULT 0,
    default_terms TEXT DEFAULT '',
    default_notes TEXT DEFAULT '',
    default_payment_terms TEXT DEFAULT 'Due on receipt',
    show_qr INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER DEFAULT 1,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff','accountant')),
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER DEFAULT 1,
    name TEXT NOT NULL,
    business_name TEXT DEFAULT '',
    address TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    gstin TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER DEFAULT 1,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    price REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(business_id, sku)
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER DEFAULT 1,
    invoice_number TEXT UNIQUE NOT NULL,
    customer_id INTEGER,
    -- snapshot of customer at generation time (historical accuracy)
    cust_name TEXT DEFAULT '',
    cust_business TEXT DEFAULT '',
    cust_address TEXT DEFAULT '',
    cust_phone TEXT DEFAULT '',
    cust_email TEXT DEFAULT '',
    cust_gstin TEXT DEFAULT '',
    -- snapshot of business at generation time
    biz_snapshot TEXT DEFAULT '{}',
    invoice_date TEXT NOT NULL,
    due_date TEXT,
    subtotal REAL DEFAULT 0,
    discount_total REAL DEFAULT 0,
    tax_total REAL DEFAULT 0,
    total REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    terms TEXT DEFAULT '',
    status TEXT DEFAULT 'Unpaid' CHECK (status IN ('Unpaid','Partially Paid','Paid','Overdue','Cancelled')),
    qr_snapshot_path TEXT DEFAULT '',
    show_qr INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    product_id INTEGER,
    sku TEXT DEFAULT '',
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    quantity REAL NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT DEFAULT 'UPI' CHECK (method IN ('UPI','Cash','Bank Transfer','Card','Other')),
    payment_date TEXT NOT NULL,
    reference TEXT DEFAULT '',
    note TEXT DEFAULT '',
    recorded_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
    FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER DEFAULT 1,
    user_id INTEGER,
    user_name TEXT DEFAULT '',
    action TEXT NOT NULL,
    entity TEXT DEFAULT '',
    entity_id TEXT DEFAULT '',
    meta TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  `);

  // migration: invoice-level extra discount (flat ₹ off the whole invoice)
  const invCols = db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  if (!invCols.includes('extra_discount')) {
    db.prepare('ALTER TABLE invoices ADD COLUMN extra_discount REAL DEFAULT 0').run();
  }

  // seed business row (defaults match the invoice template's business)
  const biz = db.prepare('SELECT * FROM businesses WHERE id=1').get();
  if (!biz) {
    db.prepare(`INSERT INTO businesses (id, business_name, legal_name, phone, email, addr1, city, state, pin, country, website, upi_id, default_notes, default_terms)
      VALUES (1,'Inginus Studios','Inginus Studios','+916205708606','','Danapur','Danapur, Patna','Bihar','','India','@inginusstudios.vercel.app','6205708606-x77d@ibl','Thank you for your business.','Payment due within 7 days.')`).run();
  } else if (biz.business_name === 'Acme Traders') {
    // migrate untouched default profile to the template's business
    db.prepare(`UPDATE businesses SET business_name='Inginus Studios', legal_name='Inginus Studios',
      phone='+916205708606', city='Danapur, Patna', state='Bihar',
      website='@inginusstudios.vercel.app', upi_id='6205708606-x77d@ibl',
      updated_at=datetime('now') WHERE id=1`).run();
  }

  // seed admin
  const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  if (adminCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare("INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,? ,1)")
      .run('Admin', 'admin@business.local', hash, 'admin');
    console.log('Seeded admin: admin@business.local / admin123');
  }

  // seed demo products (tax defaults to 0 — staff adds tax per item only if needed)
  const pCount = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  if (pCount === 0) {
    seedDemoProducts();
  } else {
    // one-time: demo SKUs shipped with 18% tax — zero them only if no invoice
    // history exists yet (nothing historical to preserve)
    const used = db.prepare('SELECT COUNT(*) c FROM invoice_items').get().c;
    if (used === 0) {
      db.prepare(`UPDATE products SET tax=0 WHERE sku IN ('GRC-001','SVC-002','PRN-010')`).run();
    }
  }
}

function seedDemoProducts() {
  const ins = db.prepare('INSERT INTO products (sku,name,description,price,tax,active) VALUES (?,?,?,?,?,1)');
  ins.run('GRC-001', 'Google Review QR Card', 'NFC + QR review card', 999, 0);
  ins.run('SVC-002', 'Installation Service', 'On-site setup', 499, 0);
  ins.run('PRN-010', 'Premium Standee', 'A3 acrylic standee', 1499, 0);
}

// Factory reset (admin only). Wipes all transactional data, restores default
// business profile + demo products. The requesting admin account is preserved
// so nobody gets locked out. Callers should back up data.db first.
function factoryReset(keepUserId) {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM payments').run();
    db.prepare('DELETE FROM invoice_items').run();
    db.prepare('DELETE FROM invoices').run();
    db.prepare('DELETE FROM customers').run();
    db.prepare('DELETE FROM products').run();
    db.prepare('DELETE FROM audit_logs').run();
    db.prepare('DELETE FROM users WHERE id != ?').run(keepUserId);
    for (const t of ['payments', 'invoice_items', 'invoices', 'customers', 'products', 'audit_logs']) {
      db.prepare(`DELETE FROM sqlite_sequence WHERE name='${t}'`).run();
    }
    db.prepare(`UPDATE businesses SET business_name='Inginus Studios', legal_name='Inginus Studios',
      logo_path='', gstin='', pan='', website='@inginusstudios.vercel.app',
      phone='+916205708606', alt_phone='', email='', whatsapp='',
      addr1='Danapur', addr2='', city='Danapur, Patna', state='Bihar', pin='', country='India',
      upi_id='6205708606-x77d@ibl', bank_name='', account_holder='', account_number='', ifsc='',
      qr_image_path='', invoice_prefix='INV-', next_invoice_number=1, currency='₹', default_tax=0,
      default_terms='Payment due within 7 days.', default_notes='Thank you for your business.',
      default_payment_terms='Due on receipt', show_qr=1, updated_at=datetime('now') WHERE id=1`).run();
    seedDemoProducts();
  });
  txn();
}


function audit({ user, action, entity = '', entity_id = '', meta = '' }) {
  try {
    db.prepare(`INSERT INTO audit_logs (business_id,user_id,user_name,action,entity,entity_id,meta)
      VALUES (1,?,?,?,?,?,?)`).run(
      user ? user.id : null, user ? user.name : 'system', action, entity, String(entity_id), typeof meta === 'string' ? meta : JSON.stringify(meta)
    );
  } catch (e) { console.error('audit fail', e.message); }
}

function paidSum(invoiceId) {
  const r = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?').get(invoiceId);
  return r ? r.s : 0;
}

function computeStatus(invoice, paid) {
  if (invoice.status === 'Cancelled') return 'Cancelled';
  const total = Number(invoice.total || 0);
  if (paid >= total && total > 0) return 'Paid';
  if (invoice.due_date) {
    const today = new Date().toISOString().slice(0, 10);
    if (invoice.due_date < today && (total - paid) > 0.005) return 'Overdue';
  }
  if (paid <= 0.005) return 'Unpaid';
  if (paid < total - 0.005) return 'Partially Paid';
  return 'Paid';
}

function refreshStatus(invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
  if (!inv || inv.status === 'Cancelled') return inv;
  const paid = paidSum(invoiceId);
  const st = computeStatus(inv, paid);
  if (st !== inv.status) {
    db.prepare("UPDATE invoices SET status=?, updated_at=datetime('now') WHERE id=?").run(st, invoiceId);
    inv.status = st;
  }
  return inv;
}

module.exports = { db, init, audit, paidSum, computeStatus, refreshStatus, factoryReset };
