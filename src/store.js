// Single storage backend: local SQLite. Deployed as a plain Node web service
// (Render / Docker / VPS), all state lives on the mounted disk via DATA_DIR.
module.exports = require('./store-sqlite');