const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

for (const d of ['uploads', 'invoices']) {
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
}

// DB stores relative paths like "uploads/x.png" — always resolve under DATA_DIR.
function resolveData(rel) {
  if (!rel) return null;
  const p = path.isAbsolute(rel) ? rel : path.join(DATA_DIR, rel);
  return fs.existsSync(p) ? p : null;
}

module.exports = { resolveData };
