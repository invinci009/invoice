const path = require('path');

const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT || 3000);
// All persistent state (SQLite db, uploads, generated PDFs) lives under DATA_DIR.
// Point it at a mounted volume in production — SQLite needs a persistent disk.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..');

const DEFAULT_JWT = 'invoice-secret-change-me';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT;

if (NODE_ENV === 'production' && JWT_SECRET === DEFAULT_JWT) {
  console.error('FATAL: JWT_SECRET must be set in production (NODE_ENV=production).');
  console.error('Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

module.exports = { NODE_ENV, PORT, DATA_DIR, JWT_SECRET };
