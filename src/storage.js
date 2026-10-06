// File storage abstraction over the local filesystem (Render / Docker / VPS).
// All paths are relative, e.g. "uploads/qr-123.png", "invoices/INV-1.pdf",
// "backups/x.json" — resolved under DATA_DIR, which must be a persistent disk.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

function localStorage() {
  for (const d of ['uploads', 'invoices', 'backups']) {
    fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
  }
  const full = rel => path.join(DATA_DIR, rel);
  return {
    kind: 'local',
    async save(rel, buffer, contentType) {
      fs.mkdirSync(path.dirname(full(rel)), { recursive: true });
      fs.writeFileSync(full(rel), buffer);
      return rel;
    },
    async get(rel) {
      if (!rel) return null;
      const p = full(rel);
      if (!fs.existsSync(p)) return null;
      return { buffer: fs.readFileSync(p), contentType: guessType(rel) };
    },
    async del(rel) {
      try { fs.unlinkSync(full(rel)); } catch {}
    },
    async copy(srcRel, destRel) {
      fs.mkdirSync(path.dirname(full(destRel)), { recursive: true });
      fs.copyFileSync(full(srcRel), full(destRel));
    },
    async list(prefix) {
      const dir = full(prefix);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter(f => fs.statSync(path.join(dir, f)).isFile())
        .map(f => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, size: st.size, created: st.mtime.toISOString() };
        })
        .sort((a, b) => (a.name < b.name ? 1 : -1));
    },
    async clearPrefix(prefix) {
      const dir = full(prefix);
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    },
  };
}

function guessType(rel) {
  if (rel.endsWith('.pdf')) return 'application/pdf';
  if (rel.endsWith('.json')) return 'application/json';
  if (/\.jpe?g$/i.test(rel)) return 'image/jpeg';
  if (/\.webp$/i.test(rel)) return 'image/webp';
  return 'image/png';
}

function getStorage() {
  return localStorage();
}

module.exports = { getStorage, guessType };
