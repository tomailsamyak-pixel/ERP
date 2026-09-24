-- The Men's Essential — ERP schema (PostgreSQL 14+)
-- Ledger-based stock, GST-aware billing, multi-outlet.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ===== Org / users =====
CREATE TABLE outlets (
  id            TEXT PRIMARY KEY,             -- e.g. 'FL','CM'
  name          TEXT NOT NULL,
  address       TEXT,
  state_code    TEXT NOT NULL,                -- GST state code, e.g. '24'
  gstin         TEXT
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  phone         TEXT UNIQUE NOT NULL,
  pin_hash      TEXT NOT NULL,                -- bcrypt hash of login PIN/password
  role          TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  home_outlet   TEXT REFERENCES outlets(id),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Catalog =====
CREATE TABLE products (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  style_code    TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,                -- shirt, tee, trouser, ...
  fabric        TEXT,
  season        TEXT,
  hsn_code      TEXT NOT NULL DEFAULT '6109',
  base_mrp      NUMERIC(10,2) NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE variants (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku           TEXT UNIQUE NOT NULL,
  size          TEXT NOT NULL,
  color         TEXT NOT NULL,
  barcode       TEXT UNIQUE NOT NULL,
  mrp           NUMERIC(10,2) NOT NULL,       -- can override product base_mrp
  cost_price    NUMERIC(10,2) NOT NULL DEFAULT 0,  -- rolling avg landed cost
  reorder_level INT NOT NULL DEFAULT 3,
  active        BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX idx_variants_product ON variants(product_id);

-- ===== Stock ledger (immutable; current stock = SUM(qty_delta)) =====
CREATE TABLE stock_movements (
  id            BIGSERIAL PRIMARY KEY,
  variant_id    UUID NOT NULL REFERENCES variants(id),
  outlet_id     TEXT NOT NULL REFERENCES outlets(id),
  qty_delta     INT NOT NULL,                 -- +in / -out
  reason        TEXT NOT NULL CHECK (reason IN
                  ('grn','sale','sale_return','exchange_in','exchange_out',
                   'transfer_in','transfer_out','stocktake_adjust','damage','opening')),
  ref_type      TEXT,                         -- 'invoice','grn','po','transfer','stocktake'
  ref_id        TEXT,
  unit_cost     NUMERIC(10,2),                -- cost at time of movement (for 'grn'/'opening')
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stockmv_variant_outlet ON stock_movements(variant_id, outlet_id);
CREATE INDEX idx_stockmv_ref ON stock_movements(ref_type, ref_id);

-- Convenience view: current stock per variant per outlet
CREATE VIEW stock_current AS
  SELECT variant_id, outlet_id, SUM(qty_delta)::INT AS qty
  FROM stock_movements GROUP BY variant_id, outlet_id;

-- ===== Suppliers / Purchases =====
CREATE TABLE suppliers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  gstin         TEXT,
  phone         TEXT,
  address       TEXT,
  opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE purchase_orders (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_no         TEXT UNIQUE NOT NULL,
  supplier_id   UUID NOT NULL REFERENCES suppliers(id),
  outlet_id     TEXT NOT NULL REFERENCES outlets(id),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','received','cancelled')),
  created_by    UUID REFERENCES users(id),
  approved_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE po_lines (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id         UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  variant_id    UUID NOT NULL REFERENCES variants(id),
  qty_ordered   INT NOT NULL,
  unit_cost     NUMERIC(10,2) NOT NULL
);

CREATE TABLE grns (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  grn_no        TEXT UNIQUE NOT NULL,
  po_id         UUID REFERENCES purchase_orders(id),
  supplier_id   UUID NOT NULL REFERENCES suppliers(id),
  outlet_id     TEXT NOT NULL REFERENCES outlets(id),
  freight       NUMERIC(10,2) NOT NULL DEFAULT 0,
  other_charges NUMERIC(10,2) NOT NULL DEFAULT 0,
  allocation_method TEXT NOT NULL DEFAULT 'value' CHECK (allocation_method IN ('value','qty')),
  received_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE grn_lines (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  grn_id        UUID NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
  variant_id    UUID NOT NULL REFERENCES variants(id),
  qty_received  INT NOT NULL,
  unit_cost     NUMERIC(10,2) NOT NULL,        -- base cost before landed-cost allocation
  landed_unit_cost NUMERIC(10,2)                -- computed after allocating freight/other_charges
);

CREATE TABLE supplier_payments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  supplier_id   UUID NOT NULL REFERENCES suppliers(id),
  amount        NUMERIC(12,2) NOT NULL,
  mode          TEXT NOT NULL,
  ref_note      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Customers =====
CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  phone         TEXT UNIQUE NOT NULL,
  gstin         TEXT,
  state_code    TEXT,
  loyalty_points INT NOT NULL DEFAULT 0,
  store_credit  NUMERIC(10,2) NOT NULL DEFAULT 0,
  measurements  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Sales / POS =====
CREATE TABLE invoices (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_no    TEXT UNIQUE NOT NULL,          -- e.g. FL/R1/00173
  outlet_id     TEXT NOT NULL REFERENCES outlets(id),
  customer_id   UUID REFERENCES customers(id),
  cashier_id    UUID NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','held','void','partial')),
  subtotal      NUMERIC(10,2) NOT NULL,
  discount_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  taxable_total NUMERIC(10,2) NOT NULL,
  cgst_total    NUMERIC(10,2) NOT NULL DEFAULT 0,
  sgst_total    NUMERIC(10,2) NOT NULL DEFAULT 0,
  igst_total    NUMERIC(10,2) NOT NULL DEFAULT 0,
  grand_total   NUMERIC(10,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at     TIMESTAMPTZ,
  void_reason   TEXT
);

CREATE TABLE invoice_lines (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id    UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  variant_id    UUID NOT NULL REFERENCES variants(id),
  qty           INT NOT NULL,
  mrp           NUMERIC(10,2) NOT NULL,
  line_discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  taxable_value NUMERIC(10,2) NOT NULL,
  gst_rate      NUMERIC(4,2) NOT NULL,          -- 5.00 or 18.00
  cgst          NUMERIC(10,2) NOT NULL DEFAULT 0,
  sgst          NUMERIC(10,2) NOT NULL DEFAULT 0,
  igst          NUMERIC(10,2) NOT NULL DEFAULT 0
);

CREATE TABLE payments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id    UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL CHECK (mode IN ('cash','upi','card','credit','store_credit')),
  amount        NUMERIC(10,2) NOT NULL
);

CREATE TABLE credit_notes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cn_no         TEXT UNIQUE NOT NULL,
  original_invoice_id UUID NOT NULL REFERENCES invoices(id),
  reason        TEXT NOT NULL CHECK (reason IN ('return','exchange')),
  amount        NUMERIC(10,2) NOT NULL,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Shifts / cash =====
CREATE TABLE shifts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  outlet_id     TEXT NOT NULL REFERENCES outlets(id),
  cashier_id    UUID NOT NULL REFERENCES users(id),
  opening_cash  NUMERIC(10,2) NOT NULL DEFAULT 0,
  closing_cash  NUMERIC(10,2),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

-- ===== Audit log =====
CREATE TABLE activity_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id),
  action        TEXT NOT NULL,
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
