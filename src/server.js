const { PORT, NODE_ENV } = require('./config');
const { app, store } = require('./app');

(async () => {
  await store.init();
  const server = app.listen(PORT, () => console.log(`Invoice app (${NODE_ENV}, ${store.kind}) running at http://localhost:${PORT}`));

  // Graceful shutdown (flush SQLite WAL on container stop)
  function shutdown(signal) {
    console.log(`\n${signal} received, shutting down…`);
    server.close(() => {
      if (store.kind === 'sqlite') {
        try { const { db } = require('./db'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch {}
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
