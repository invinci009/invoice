# Deployment Guide — Invoice Manager

Deployment guide for the Invoice Generator & Payment Tracker (Node + Express + SQLite + PDFKit).

---

## 1. What you are deploying

| Piece | Detail |
|---|---|
| Runtime | Node.js **≥ 22.13** (see [§2](#2-critical-node-version-requirement)) |
| Server | Express 4, single process |
| Database | SQLite via the built-in `node:sqlite` module (**no native build step**) |
| Storage | Local filesystem under `DATA_DIR` |
| Frontend | Vanilla JS SPA, no build step |
| Dependencies | 8 runtime packages, all pure JS |

### State that MUST be on a persistent disk

Everything lives under `DATA_DIR`:

```
$DATA_DIR/
├── data.db          ← SQLite database (+ -wal, -shm)
├── data.db-wal
├── data.db-shm
├── uploads/         ← business logo + business QR image
├── invoices/        ← generated PDFs + per-invoice QR snapshots
└── backups/         ← JSON exports created by the admin UI
```

> **This is the single most important thing in this document.** The container
> filesystem is ephemeral on every platform that isn't a plain VPS. If
> `DATA_DIR` is not on a mounted volume, **every deploy silently wipes all
> invoices, payments, and customers** — and the app will come back up smiling,
> freshly seeded, looking like it worked.

### Runtime configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `JWT_SECRET` | **Yes in production** | `invoice-secret-change-me` | Process **refuses to boot** if `NODE_ENV=production` and this is unset/default |
| `NODE_ENV` | Recommended | `development` | Set to `production` to enable the secret check |
| `PORT` | No | `3000` | Set `8080` on Fly.io |
| `DATA_DIR` | **Effectively yes** | project root | Point at a mounted volume |

There is **no `.env` loading** — the app reads `process.env` only. `docker-compose.yml`
injects `.env` itself via `env_file`, so it works there; for anything else export the
variables through your platform's secret/env UI.

---

## 2. Critical Node version requirement

The app uses `node:sqlite`, which is the reason it has **zero native compilation**
(no `better-sqlite3`, no `node-gyp`, no build tools in the image).

That convenience has a sharp edge:

| Node version | `node:sqlite` |
|---|---|
| `< 22.5` | Module does not exist |
| `22.5.0` – `22.12.x` | Exists but **requires `--experimental-sqlite`** — the app crashes on boot |
| **`≥ 22.13`** | Unflagged. ✅ Works |

The `package.json` `engines` field is set to `>=22.13` and the `Dockerfile` pins
`node:22.13-bookworm-slim` so the image can't silently regress into the broken range.

If you deploy to a host with a Node version you don't control, verify before going live:

```bash
node -e "require('node:sqlite'); console.log('ok', process.version)"
```

---

## 3. Pre-flight checklist

Run these locally before deploying anything.

```bash
# 1. Syntax check every source file
npm run check

# 2. Start the app
npm start

# 3. In a second shell, run the end-to-end suite (64 assertions)
npm test
```

`npm test` hits the live server and covers auth, RBAC for all three roles, invoice
math, snapshot immutability, payment lifecycle and status derivation, overpayment
guards, PDF generation, cancel, validation, and injection-shaped input.

> **The suite creates real rows.** It creates staff/accountant users, a customer,
> and ~6 invoices per run. See [§10](#10-after-you-run-the-test-suite) for cleanup.
>
> It also performs ~3 logins. The login rate limiter allows **30 attempts / 15 min**
> per IP, so back-to-back runs will start returning `429`. Restart the server (the
> limiter is in-memory) or wait it out.

---

## 4. Deploying with Docker (recommended)

### 4.1 Build and run

```bash
docker build -t invoice-app .

docker run -d \
  --name invoice-app \
  -p 8080:3000 \
  -v invoice-data:/data \
  -e NODE_ENV=production \
  -e DATA_DIR=/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  --restart unless-stopped \
  invoice-app
```

Verify:

```bash
curl http://localhost:8080/api/health
# {"ok":true,...,"backend":"sqlite"}
```

### 4.2 With docker compose

`docker-compose.yml` is already wired with the volume, healthcheck, and `env_file`.
Create your `.env` first:

```bash
cp .env.example .env
# then edit .env and set a real JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
docker compose up -d --build
docker compose logs -f
```

### 4.3 Verify the volume actually persisted

The single highest-value check after your **second** deploy, because it is the only
time you can still catch a lost volume:

```bash
# create a test invoice in the UI, note its number, then:
docker compose down && docker compose up -d
# log back in — the invoice must still be there
```

---

## 5. Deploying to Fly.io

Fly Machines have **ephemeral local disk**. A volume is mandatory, not optional.

### 5.1 Install and authenticate

```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"   # Windows
```

```bash
fly version
fly auth login      # opens a browser; approve it there
```

### 5.2 Create the app and its volume

Volume first — a Machine can't be given one after it exists.

```bash
fly apps create invoice-manager --region bom     # bom = Mumbai; pick your users' region
fly volumes create invoice_data --size 1 --region bom
```

### 5.3 `fly.toml`

This file is **not** in the repo. Create it at the project root:

```toml
app = "invoice-manager"
primary_region = "bom"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "8080"          # MUST match internal_port
  DATA_DIR = "/data"

[[mounts]]
  source = "invoice_data"
  destination = "/data"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = "/api/health"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

### 5.4 Secrets and deploy

```bash
fly secrets set JWT_SECRET="$(openssl rand -hex 32)"

fly deploy
fly status
fly apps open          # opens the live URL in your browser
fly logs               # when something is wrong
```

### 5.5 Constraints specific to this app

- **Scale = 1.** SQLite plus a Fly volume means one writer. Never set
  `min_machines_running > 1` or run two Machines against one volume — you will get
  `SQLITE_BUSY` and, worse, last-writer-wins corruption.
- `auto_stop_machines = "stop"` lets it sleep when idle, but the process must
  survive a wake. It does: state is on the volume, and `SIGTERM` triggers a WAL
  checkpoint via the handler in `src/server.js`.
- Fly provides `fly machine restart` as your recovery tool if a deploy lands badly.

---

## 6. Deploying to Render

Render's free tier has ephemeral disks and **will lose your data**. Use a paid
persistent-disk service, or Render Postgres + a storage rewrite.

1. New → Web Service, connect the repo.
2. Runtime: **Docker**. Render reads your `Dockerfile` directly.
3. Health check path: `/api/health`.
4. Environment: `NODE_ENV=production`, `DATA_DIR=/data`, `JWT_SECRET=<64 hex chars>`.
5. Attach a **Disk** mounted at `/data`.
6. Deploy.

---

## 7. Deploying to a plain VPS (systemd + nginx)

Best durability-to-effort ratio if you have a server.

```bash
# app user + code
sudo adduser --system --group --home /srv/invoice invoice
sudo -u invoice git clone <your-repo> /srv/invoice/app
cd /srv/invoice/app && sudo -u invoice npm ci --omit=dev

# persistent data dir
sudo -u invoice mkdir -p /var/lib/invoice
sudo chown invoice:invoice /var/lib/invoice

# strong secret
openssl rand -hex 32 | sudo tee /etc/invoice.env
sudo chmod 600 /etc/invoice.env
```

`/etc/systemd/system/invoice.service`:

```ini
[Unit]
Description=Invoice Manager
After=network.target

[Service]
Type=simple
User=invoice
Group=invoice
WorkingDirectory=/srv/invoice/app
EnvironmentFile=/etc/invoice.env
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/invoice
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/invoice

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now invoice
sudo systemctl status invoice
```

nginx `/etc/nginx/sites-available/invoice`:

```nginx
server {
    listen 443 ssl http2;
    server_name invoices.example.com;

    ssl_certificate     /etc/letsencrypt/live/invoices.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/invoices.example.com/privkey.pem;

    client_max_body_size 8m;   # logo/QR uploads are capped at 5MB server-side

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> `app.set('trust proxy', 1)` is already set, which is what makes
> `express-rate-limit` see the real client IP behind nginx.

### systemd note

Use `Restart=always`, **not** `restart=on-failure`. This app calls `process.exit(1)`
deliberately on config errors (`src/config.js`) and after a 10-second shutdown
timeout. `on-failure` would leave the service down after a bad deploy; `always`
restarts it so you get a fast, obvious crash-loop you can read in the journal.

---

## 8. First-run smoke test

After every deploy, in order:

```bash
# 1. Liveness
curl -s https://your-host/api/health
# expect: {"ok":true,...,"backend":"sqlite"}

# 2. CSP present and permissive for inline handlers
curl -sI https://your-host/ | grep -i content-security-policy
# must contain: script-src-attr 'unsafe-inline'
# If it says 'none', every button in the UI is dead — see §11.

# 3. Login works
curl -s -X POST https://your-host/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@business.local","password":"admin123"}'
```

Then in a browser: sign in, open an invoice, click **Pay** (modal opens) and
**PDF** (file downloads). Those two buttons are the fastest end-to-end smoke test
in the app — they exercise the DB, auth, and PDF pipeline in one click each.

Finally, **change the default admin password** and delete the seeded demo customer
if you don't want it visible.

---

## 9. Backups

The app has a built-in JSON export: **Settings → Backups → Create backup**
(`POST /api/admin/reset-database` writes one before resetting; the export endpoint is
admin-only). Backing up the files is simpler and more complete:

```bash
# hot backup of a live SQLite database — safe to run while the app is up
sqlite3 /var/lib/invoice/data.db ".backup '/backups/invoice-$(date +%F).db'"

# plus the uploaded assets
tar czf /backups/assets-$(date +%F).tar.gz -C /var/lib/invoice uploads invoices
```

Cron, nightly:

```cron
15 2 * * * /usr/local/bin/backup-invoice.sh >> /var/log/invoice-backup.log 2>&1
```

Test a restore at least once. A backup you have never restored is a guess.

---

## 10. After you run the test suite

`npm test` writes real data. To return to a clean slate, either use the in-app
**Settings → Reset database** (admin-only; it preserves your admin account) or
delete the rows directly:

```bash
sqlite3 /var/lib/invoice/data.db <<'SQL'
PRAGMA foreign_keys=ON;
BEGIN;
DELETE FROM payments;
DELETE FROM invoice_items;
DELETE FROM invoices;
DELETE FROM customers;
DELETE FROM audit_logs;
UPDATE businesses SET next_invoice_number = 1;
COMMIT;
SQL
```

Test users are created with `health_staff_*@t.local` / `health_acct_*@t.local`
emails; the suite deletes its own on a clean pass, but a crashed run leaves them:

```bash
sqlite3 /var/lib/invoice/data.db \
  "DELETE FROM users WHERE email LIKE 'health_%@t.local';"
```

**Also delete the matching orphaned files in `$DATA_DIR/invoices/`** — each invoice
copies a ~136 KB QR snapshot there at creation, and nothing garbage-collects them.
Budget roughly **136 KB per invoice** for `invoices/`.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Buttons render but do nothing | CSP `script-src-attr 'none'` | Must be `'unsafe-inline'` — see below |
| PDF button shows `{"error":"Unauthorized"}` | Same root cause; the `<a href>` falls through without the `Authorization` header | Same fix |
| App exits immediately, logs show `FATAL: JWT_SECRET` | `NODE_ENV=production` with default secret | `fly secrets set JWT_SECRET=...` / add to env file |
| `Cannot find module 'node:sqlite'` or flag error | Node < 22.13 | Upgrade, or use the pinned Dockerfile |
| All data gone after deploy | `DATA_DIR` on ephemeral disk | Attach a volume; restore from backup |
| `SQLITE_BUSY` / database locked | More than one process/container on one volume | Scale to exactly 1 |
| `429 Too many login attempts` | 30 attempts / 15 min per IP | Wait 15 min or restart the server |
| Login works, then everything 401s | `JWT_SECRET` changed → old tokens invalid | Expected; users re-login |
| Uploads 413 / rejected | 5 MB server-side cap | Re-export the QR under 5 MB |

### The CSP gotcha (worth understanding, not just fixing)

Helmet's `contentSecurityPolicy` defaults `script-src-attr` to `'none'` whenever you
set `scriptSrc` without explicitly setting `scriptSrcAttr`. This SPA wires actions
with inline `onclick="..."` attributes, so **every button handler is silently
discarded by the browser**. There is no console error worth noticing in a normal
session — the buttons just render and do nothing, which reads as broken code rather
than a blocked security policy.

The current `src/app.js` sets:

```js
scriptSrc: ["'self'"],
scriptSrcAttr: ["'unsafe-inline'"],   // inline onclick handlers
styleSrc: ["'self'", "'unsafe-inline'"],
```

`script-src 'self'` is unchanged, so injected inline `<script>` blocks stay blocked.
If you ever want to drop `'unsafe-inline'` here for real, the fix is to stop using
inline handlers — a delegated listener on `document` keyed off `data-action`
attributes. That is a frontend refactor, not a config flip.

---

## 12. Security checklist

Before go-live:

- [ ] `JWT_SECRET` is 32+ random bytes and not the default
- [ ] Default admin password changed
- [ ] `NODE_ENV=production`
- [ ] `DATA_DIR` on a persistent volume, restore tested
- [ ] TLS terminated (platform or nginx); `force_https` on for Fly
- [ ] Firewall allows only 80/443 — port 3000 stays internal
- [ ] Backup cron installed **and a restore rehearsed**
- [ ] Staff accounts created with least-privilege roles
      (`admin` / `staff` / `accountant` — server-enforced, not UI-only)
- [ ] `health-check.js` passing against the live URL

### What is already handled in the code

- **Server-side RBAC** on every mutating route — role checks are in the route
  handlers, so hiding a button in the UI is never the control.
- **Password hashing** via bcrypt (cost 10).
- **Prepared statements everywhere.** No string-concatenated SQL. Input like
  `1 OR 1=1` returns 404, not data.
- **Helmet** security headers, plus the CSP above.
- **Rate limiting**: 600 req / 15 min on `/api/*`, 30 logins / 15 min.
- **Uploads**: images only, 5 MB cap, written under generated names — no
  user-controlled path.
- **Audit log** on all financial actions (login, invoice create/edit/cancel,
  payments, business settings, staff changes, DB reset).
- **Immutable invoice snapshots** — customer and business details are copied onto
  the invoice at creation, so later edits never rewrite historical invoices.
- **Overpayment blocked** server-side; totals recomputed from items, never
  trusted from the client.
- **Sequential invoice numbers** allocated inside a transaction, so concurrent
  creates cannot collide.

### Known gaps, in priority order

1. **No invoice delete endpoint.** Invoices can only be cancelled. Accumulates
   invoices, their PDFs, and their QR snapshots forever.
2. **No QR-snapshot garbage collection.** ~136 KB per invoice, never cleaned up.
3. **Login rate limit is per-IP.** Multiple staff behind one office NAT can lock
   each other out at 30 attempts / 15 min.
4. **Tokens are not revocable.** Changing `JWT_SECRET` invalidates everything at
   once; there's no per-user session revocation on disable (a disabled user is
   rejected, but their token stays valid until it expires at 12 h).
5. **No automated test suite in CI.** `health-check.js` exists and passes 64
   assertions, but nothing runs it automatically.

---

## 13. Quick reference

```bash
# local
npm install
npm run check      # syntax
npm start          # :3000
npm test           # 64 e2e assertions (server must be up)

# docker
docker compose up -d --build
docker compose logs -f

# fly
fly volumes create invoice_data --size 1 --region bom
fly secrets set JWT_SECRET="$(openssl rand -hex 32)"
fly deploy && fly status && fly logs

# backup
sqlite3 /var/lib/invoice/data.db ".backup '/backups/invoice-$(date +%F).db'"
```