// SQLite backend (local dev / VPS / Docker). Same method surface as
// store-firestore.js. IDs are numbers here, strings on Firestore — routes
// treat every ID as opaque and compare with String().
const { db, init, factoryReset: resetDb } = require('./db');
const now = () => new Date().toISOString();
const S = v => (v === undefined || v === null ? '' : String(v));

const store = {
  kind: 'sqlite',

  async init() { init(); },

  // ----- users -----
  async listUsers() {
    return db.prepare('SELECT id,name,email,role,active,created_at FROM users ORDER BY id').all();
  },
  async getUser(id) {
    return db.prepare('SELECT * FROM users WHERE id=?').get(id) || null;
  },
  async findUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase().trim()) || null;
  },
  async createUser({ name, email, password_hash, role }) {
    try {
      const r = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
        .run(name, String(email).toLowerCase().trim(), password_hash, role);
      return r.lastInsertRowid;
    } catch { throw new Error('Email already exists'); }
  },
  async updateUser(id, patch) {
    const sets = [], args = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === undefined || v === null) continue;
      sets.push(`${k}=?`); args.push(v);
    }
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...args, id);
  },

  // ----- business -----
  async getBusiness() {
    return db.prepare('SELECT * FROM businesses WHERE id=1').get();
  },
  async updateBusiness(patch) {
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ');
    if (sets) db.prepare(`UPDATE businesses SET ${sets}, updated_at=datetime('now') WHERE id=1`).run(...Object.values(patch));
  },

  // ----- customers -----
  async listCustomers() {
    return db.prepare('SELECT * FROM customers WHERE business_id=1 ORDER BY name LIMIT 500').all();
  },
  async getCustomer(id) {
    return db.prepare('SELECT * FROM customers WHERE id=?').get(id) || null;
  },
  async createCustomer(d) {
    const r = db.prepare('INSERT INTO customers (name,business_name,address,phone,email,gstin,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,datetime(\'now\'),datetime(\'now\'))')
      .run(d.name, d.business_name || '', d.address || '', d.phone || '', d.email || '', d.gstin || '', d.notes || '');
    return r.lastInsertRowid;
  },
  async updateCustomer(id, patch) {
    db.prepare('UPDATE customers SET name=?,business_name=?,address=?,phone=?,email=?,gstin=?,notes=?,updated_at=datetime(\'now\') WHERE id=?')
      .run(patch.name, patch.business_name, patch.address, patch.phone, patch.email, patch.gstin, patch.notes, id);
  },
  async deleteCustomer(id) {
    db.prepare('DELETE FROM customers WHERE id=?').run(id);
  },
  async countCustomerInvoices(customerId) {
    return db.prepare('SELECT COUNT(*) c FROM invoices WHERE customer_id=?').get(customerId).c;
  },

  // ----- products -----
  async listProducts() {
    return db.prepare('SELECT * FROM products WHERE business_id=1 ORDER BY name LIMIT 500').all();
  },
  async getProduct(id) {
    return db.prepare('SELECT * FROM products WHERE id=?').get(id) || null;
  },
  async createProduct(d) {
    try {
      const r = db.prepare('INSERT INTO products (sku,name,description,price,tax,active) VALUES (?,?,?,?,?,?)')
        .run(d.sku, d.name, d.description || '', Number(d.price || 0), Number(d.tax || 0), d.active ? 1 : 0);
      return r.lastInsertRowid;
    } catch { throw new Error('SKU already exists'); }
  },
  async updateProduct(id, patch) {
    try {
      db.prepare('UPDATE products SET sku=?,name=?,description=?,price=?,tax=?,active=? WHERE id=?')
        .run(patch.sku, patch.name, patch.description, Number(patch.price), Number(patch.tax), patch.active ? 1 : 0, id);
    } catch { throw new Error('SKU already exists'); }
  },
  async deleteProduct(id) {
    db.prepare('DELETE FROM products WHERE id=?').run(id);
  },
  async countProductUsage(productId) {
    return db.prepare('SELECT COUNT(*) c FROM invoice_items WHERE product_id=?').get(productId).c;
  },

  // ----- invoices -----
  async listInvoices() {
    return db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 500').all();
  },
  async getInvoice(id) {
    return db.prepare('SELECT * FROM invoices WHERE id=?').get(id) || null;
  },
  async invoiceNumberExists(number) {
    return !!db.prepare('SELECT id FROM invoices WHERE invoice_number=?').get(number);
  },
  // Atomic: reserve sequential number + insert invoice + items + bump counter.
  async createInvoiceFull(doc) {
    const txn = db.transaction(() => {
      const b = db.prepare('SELECT invoice_prefix, next_invoice_number FROM businesses WHERE id=1').get();
      const invNum = `${b.invoice_prefix}${String(b.next_invoice_number).padStart(6, '0')}`;
      if (db.prepare('SELECT id FROM invoices WHERE invoice_number=?').get(invNum)) {
        throw new Error('Duplicate invoice number, retry');
      }
      const {
        customer_id, cust_name, cust_business, cust_address, cust_phone, cust_email, cust_gstin,
        biz_snapshot, invoice_date, due_date, subtotal, discount_total, tax_total, total,
        notes, terms, qr_snapshot_path, show_qr, created_by, items, extra_discount,
      } = doc;
      const r = db.prepare(`INSERT INTO invoices (invoice_number,customer_id,cust_name,cust_business,cust_address,cust_phone,cust_email,cust_gstin,
        biz_snapshot,invoice_date,due_date,subtotal,discount_total,tax_total,total,extra_discount,notes,terms,status,qr_snapshot_path,show_qr,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?)`).run(
        invNum, customer_id, cust_name, cust_business, cust_address, cust_phone, cust_email, cust_gstin,
        biz_snapshot, invoice_date, due_date, subtotal, discount_total, tax_total, total, extra_discount || 0,
        notes, terms, 'Unpaid', qr_snapshot_path, show_qr, created_by
      );
      const ii = db.prepare('INSERT INTO invoice_items (invoice_id,product_id,sku,name,description,quantity,unit_price,discount,tax,total) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const it of items) {
        ii.run(r.lastInsertRowid, it.product_id || null, it.sku || '', it.name, it.description || '',
          it.quantity, it.unit_price, it.discount, it.tax, it.total);
      }
      db.prepare('UPDATE businesses SET next_invoice_number = next_invoice_number + 1 WHERE id=1').run();
      return { id: r.lastInsertRowid, invoice_number: invNum };
    });
    return txn();
  },
  async updateInvoice(id, patch) {
    const sets = [], args = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === undefined) continue;
      sets.push(`${k}=?`); args.push(v);
    }
    if (sets.length) db.prepare(`UPDATE invoices SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...args, id);
  },
  async getInvoiceItems(invoiceId) {
    return db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(invoiceId);
  },
  // All items across invoices (for global search + top-products).
  async listAllItems() {
    return db.prepare('SELECT * FROM invoice_items').all();
  },
  async replaceInvoiceItems(invoiceId, items) {
    const txn = db.transaction(() => {
      db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(invoiceId);
      const ii = db.prepare('INSERT INTO invoice_items (invoice_id,product_id,sku,name,description,quantity,unit_price,discount,tax,total) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const it of items) {
        ii.run(invoiceId, it.product_id || null, it.sku || '', it.name, it.description || '',
          it.quantity, it.unit_price, it.discount, it.tax, it.total);
      }
    });
    txn();
  },

  // ----- payments -----
  async listPayments() {
    return db.prepare('SELECT * FROM payments ORDER BY payment_date DESC LIMIT 300').all();
  },
  async getPayment(id) {
    return db.prepare('SELECT * FROM payments WHERE id=?').get(id) || null;
  },
  async createPayment(d) {
    const r = db.prepare('INSERT INTO payments (invoice_id,amount,method,payment_date,reference,note,recorded_by) VALUES (?,?,?,?,?,?,?)')
      .run(d.invoice_id, d.amount, d.method, d.payment_date, d.reference || '', d.note || '', d.recorded_by);
    return r.lastInsertRowid;
  },
  async updatePayment(id, patch) {
    const sets = [], args = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === undefined) continue;
      sets.push(`${k}=?`); args.push(v);
    }
    if (sets.length) db.prepare(`UPDATE payments SET ${sets.join(', ')} WHERE id=?`).run(...args, id);
  },
  async deletePayment(id) {
    db.prepare('DELETE FROM payments WHERE id=?').run(id);
  },

  // ----- audit -----
  async listAudit(limit = 200) {
    return db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
  },
  async addAudit(entry) {
    db.prepare(`INSERT INTO audit_logs (business_id,user_id,user_name,action,entity,entity_id,meta)
      VALUES (1,?,?,?,?,?,?)`).run(
      entry.user_id ?? null, entry.user_name || 'system', entry.action,
      entry.entity || '', String(entry.entity_id ?? ''), entry.meta || ''
    );
  },

  // ----- admin -----
  async exportAll() {
    const t = n => db.prepare(`SELECT * FROM ${n}`).all();
    return {
      exportedAt: now(), backend: 'sqlite',
      businesses: t('businesses'), users: t('users'), customers: t('customers'),
      products: t('products'), invoices: t('invoices'), invoice_items: t('invoice_items'),
      payments: t('payments'), audit_logs: t('audit_logs'),
    };
  },
  async factoryReset(keepUserId) { resetDb(keepUserId); },
};

module.exports = store;
