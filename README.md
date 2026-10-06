# Invoice Generator & Tracking — Billing & Receivables System

## Run (local)

```bash
npm install
npm start
```

Open http://localhost:3000 — login `admin@business.local` / `admin123`.

## Deploy

The app is a single Node.js service (Express + SQLite + PDFKit, no build step,
no native modules). Node **22+ required** (`engines` enforced, uses built-in
`node:sqlite`).

### Environment

| Variable     | Default        | Notes                                                        |
| ------------ | -------------- | ------------------------------------------------------------ |
| `PORT`       | `3000`         | Listen port                                                  |
| `JWT_SECRET` | (dev default)  | **Required in production** — app refuses to boot without it. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATA_DIR`   | project folder | Where `data.db`, `uploads/` and `invoices/` live. Point at a persistent volume in production. |
| `NODE_ENV`   | `development`  | Set `production` for hardened headers/secret enforcement.    |

Copy `.env.example` to `.env` for local config (never commit `.env`).

> ⚠️ SQLite stores everything in **one file** (`data.db`). On hosts with an
> ephemeral filesystem (Render free, Railway without a volume, Docker without
> a mount) you **must** attach a persistent disk/volume at `DATA_DIR`,
> otherwise invoices, users and uploads vanish on every redeploy/restart.

### Docker (recommended)

```bash
docker build -t invoice-app .
docker run -d --name invoice-app -p 3000:3000 \
  -e NODE_ENV=production \
  -e JWT_SECRET='<long-random-string>' \
  -v invoice-data:/data \
  invoice-app
```

Health check: `GET /api/health` (also wired as the Docker `HEALTHCHECK`).

### Render / Railway / VPS

- **Build command:** `npm ci`
- **Start command:** `npm start` (or `node src/app.js`)
- Add a **persistent disk** mounted at `/data` and set `DATA_DIR=/data`,
  `NODE_ENV=production`, `JWT_SECRET=<random>`.
- Behind HTTPS termination the app already sets `trust proxy`, secure
  headers (Helmet), login rate-limiting and API rate-limiting.

### Roles (enforced server-side)

- **Admin** — everything, plus exclusives: staff management, reports,
  business settings, and **database reset** (Business Settings → Danger zone,
  requires typing `RESET`; a timestamped backup is saved to `backups/` first
  and can be re-downloaded; your own admin account is preserved).
- **Staff & Accountant** — everything else: dashboard, invoices, customers,
  products, payments, audit logs.

### Firebase (free Spark plan — no card required) ⚠️ new

Same app, same UI, same PDFs — only the storage layer switches from the local
SQLite file to Firestore + Cloud Storage. Verified end-to-end against the
official emulators (auth, sequential numbering, payments, QR snapshots,
PDFs, RBAC, reset + backups).

Free quotas (Spark) are plenty for a small business: 50k Firestore reads/day,
20k writes/day, 5GB storage. Limits to know: functions sleep when idle
(first request takes a few seconds), and Spark blocks outbound calls to
non-Google services — so a future WhatsApp/email feature would need the
pay-as-you-go Blaze plan (still ~₹0 at this scale, but Blaze needs a card).

**One-time setup**

```bash
npm install -g firebase-tools
firebase login
firebase projects:create inginus-billing   # your project id (must be unique)
firebase use inginus-billing
```

**Configure** — add to your local `.env` (never commit it):

```bash
DATA_BACKEND=firestore
FIREBASE_PROJECT_ID=inginus-billing
JWT_SECRET=<long-random-string>   # same generator as above
```

functions run with `asia-south1` (Mumbai) region — change `region` in
`src/function.js` if you prefer another.

**Deploy**

```bash
firebase deploy
# deploys: hosting (dashboard UI) + functions (the /api/** backend)
#          + firestore rules (deny-all; backend uses Admin SDK)
#          + storage rules (deny-all; backend uses Admin SDK)
```

Your app is then live at `https://inginus-billing.web.app`.
First login is still `admin@business.local` / `admin123` — change it immediately.

**Local Firebase development** (optional, mirrors production exactly):

```bash
# terminal 1
npx firebase-tools emulators:start --only firestore,storage --project demo-invoice
# terminal 2
$env:DATA_BACKEND='firestore'; $env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:STORAGE_EMULATOR_HOST='http://127.0.0.1:9199'; $env:PORT='3200'; npm start
```

Note: `STORAGE_EMULATOR_HOST` needs the `http://` prefix; `FIRESTORE_EMULATOR_HOST`
must NOT have it. The emulator UI is at http://127.0.0.1:4000.

Backups on Firebase are portable JSON (Settings → Danger zone), downloadable
anytime — that plus Firestore's own durability is your safety net.

### First-run checklist

1. Login with the default admin, create your own admin, then disable/delete it via Staff.
2. Business Settings → fill profile, **upload your payment QR**, toggle Show QR.
3. Change invoice prefix/numbering if needed, then create the first invoice.

## Features
- Dashboard KPIs (invoiced / received / outstanding / overdue), revenue chart, status donut, top customers/products, recent invoices with search/filter
- Invoice generator: customer select-or-create, product/SKU autocomplete, auto totals, sequential backend numbering (INV-000001…), preview + PDF
- **Payment QR is a static uploaded business image only.** Never auto-generated, never a UPI URI, never invoice-specific. Settings → upload/preview/replace/remove + `Show Payment QR on Invoice` ON/OFF. QR snapshot copied per invoice for historical accuracy.
- PDF (PDFKit) reproduces your original purple invoice template: branded sidebar, bill-to, SKU item table, totals, payment info + QR box, notes/terms, Thank-You footer
- Tracking: Unpaid / Partially Paid / Paid / Overdue (derived from payments) / Cancelled; record payments with overpayment guard
- Customers (stats + history), Products/SKUs, Payments log, Reports + CSV, Staff roles (admin/staff/accountant, enforced server-side), Audit logs
- Responsive SaaS UI, toasts, confirmations, empty/loading/error states
- Mobile-ready: bottom navigation bar, bottom-sheet dialogs, 44px touch targets,
  stacked invoice form, full-bleed scrollable tables, no iOS input zoom

## Security
JWT auth, bcrypt, role middleware on every write route, audit trail on financial actions.

## Data
SQLite (`data.db`) — Businesses, Users, Customers, Products, Invoices (+snapshot fields), InvoiceItems, Payments, AuditLogs. Uploads in `uploads/`, PDFs in `invoices/`.
