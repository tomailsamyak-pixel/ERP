# The Men's Essential — ERP + POS Backend

A real backend for the Threadline/TME retail ERP demo: PostgreSQL for storage, an
Express API on top. This is the "phase 2" step after the in-browser HTML demo —
data now survives a refresh, lives in a real database, and is served over a proper API.

## What's here

- `db/schema.sql` — full PostgreSQL schema: outlets, users, products/variants,
  a ledger-based stock model, purchases (PO → GRN with landed-cost allocation),
  POS invoices with Indian GST logic (5%/18% apparel slab, CGST/SGST vs IGST),
  customers, credit notes, shifts, and an audit log.
- `db/seed.js` — populates two outlets, three test logins, four sample products
  with size/colour variants and opening stock, and a walk-in customer.
- `src/` — the Express API: auth (phone + PIN, JWT), products/stock, purchases,
  POS/invoices, customers, reports.

## Requirements

- Node.js 18+
- PostgreSQL 14+

## Setup

```bash
npm install
cp .env.example .env        # then edit .env with your real DATABASE_URL and JWT_SECRET
npm run migrate             # applies db/schema.sql
npm run seed                # loads sample data + test logins
npm start                   # starts the API on http://localhost:4000
```

### Test logins (from the seed script)

| Role    | Phone      | PIN  |
|---------|------------|------|
| Owner   | 9999900000 | 1234 |
| Manager | 9999900001 | 1234 |
| Cashier | 9999900002 | 1111 |

## API overview

All routes except `/auth/login` require `Authorization: Bearer <token>`.

- `POST /auth/login` — `{ phone, pin }` → `{ token, user }`
- `GET /products` — catalog with variants and stock per outlet
- `GET /products/variant/:barcode` — barcode-scan lookup for POS
- `POST /products` — create a product + variants (owner/manager)
- `POST /products/transfer` — move stock between outlets (owner/manager)
- `POST /products/stocktake` — apply a physical-count adjustment (owner/manager)
- `POST /purchases/po` / `POST /purchases/po/:id/approve` — purchase orders
- `POST /purchases/grn` — receive stock, allocate freight/other charges into landed cost
- `POST /purchases/supplier-payment`, `GET /purchases/suppliers/:id/ledger`
- `POST /pos/invoices` — create a bill (computes GST per line, checks stock, records payments)
- `GET /pos/invoices/:id`
- `POST /pos/invoices/:id/void` — owner/manager only; restores stock
- `POST /pos/credit-notes` — returns/exchanges
- `GET /customers`, `POST /customers`, `PATCH /customers/:id`, `GET /customers/:id/invoices`
- `GET /reports/sales`, `GET /reports/stock`, `GET /reports/gst`, `GET /reports/movers`

## GST logic

Apparel is taxed at 5% if the per-piece price **after discount** is ≤ ₹2,500, and
18% above that — this is computed per line, not per invoice, since a single bill
can mix items across both slabs. Intra-state sales split the tax into CGST + SGST;
inter-state sales use IGST. See `src/utils/gst.js`.

## What this does NOT include yet

This covers the core transactional flows and matches the schema in the design doc,
but it's a foundation, not the finished system. Not yet built: the offline-sync
protocol for POS terminals, e-invoicing/GSTR filing integration, loyalty-point
accrual rules, shift cash-reconciliation endpoints, and the frontend itself (the
existing HTML demo would need to be rewired to call this API instead of using
in-memory data).

## Connecting the existing demo to this API

The HTML demo currently keeps all data in JavaScript variables in the browser.
To make it use this backend instead, the demo's data functions (cart/checkout,
stock lookups, reports) would be swapped for `fetch()` calls to these endpoints,
and the login screen would call `POST /auth/login` instead of a hardcoded PIN
check. That rewire is a separate piece of work from this backend itself.
