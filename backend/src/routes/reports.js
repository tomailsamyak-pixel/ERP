const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD&outlet_id=FL
router.get('/sales', requireRole('owner', 'manager'), async (req, res) => {
  const { from, to, outlet_id } = req.query;
  const { rows } = await db.query(
    `SELECT date_trunc('day', created_at) AS day, outlet_id,
            COUNT(*) AS bills, SUM(grand_total) AS revenue
     FROM invoices
     WHERE status <> 'void'
       AND ($1::date IS NULL OR created_at >= $1::date)
       AND ($2::date IS NULL OR created_at < ($2::date + interval '1 day'))
       AND ($3::text IS NULL OR outlet_id = $3)
     GROUP BY 1,2 ORDER BY 1`,
    [from || null, to || null, outlet_id || null]
  );
  res.json(rows);
});

// GET /reports/stock — current stock, valued at cost, with low-stock flags
router.get('/stock', requireRole('owner', 'manager'), async (req, res) => {
  const { rows } = await db.query(`
    SELECT v.sku, v.size, v.color, p.name AS product_name, sc.outlet_id, sc.qty,
           v.cost_price, (sc.qty * v.cost_price) AS stock_value,
           (sc.qty <= v.reorder_level) AS low_stock
    FROM stock_current sc
    JOIN variants v ON v.id = sc.variant_id
    JOIN products p ON p.id = v.product_id
    ORDER BY p.name, v.sku
  `);
  res.json(rows);
});

// GET /reports/gst?from=&to= — HSN-wise summary, GSTR-1-style
router.get('/gst', requireRole('owner', 'manager'), async (req, res) => {
  const { from, to } = req.query;
  const { rows } = await db.query(
    `SELECT p.hsn_code, il.gst_rate,
            SUM(il.qty) AS qty,
            SUM(il.taxable_value) AS taxable_value,
            SUM(il.cgst) AS cgst, SUM(il.sgst) AS sgst, SUM(il.igst) AS igst
     FROM invoice_lines il
     JOIN invoices i ON i.id = il.invoice_id
     JOIN variants v ON v.id = il.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE i.status <> 'void'
       AND ($1::date IS NULL OR i.created_at >= $1::date)
       AND ($2::date IS NULL OR i.created_at < ($2::date + interval '1 day'))
     GROUP BY p.hsn_code, il.gst_rate
     ORDER BY p.hsn_code, il.gst_rate`,
    [from || null, to || null]
  );
  res.json(rows);
});

// GET /reports/movers — best/slow sellers by qty sold
router.get('/movers', requireRole('owner', 'manager'), async (req, res) => {
  const { rows } = await db.query(`
    SELECT p.name AS product_name, v.sku, SUM(il.qty) AS qty_sold, SUM(il.taxable_value) AS revenue
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id AND i.status <> 'void'
    JOIN variants v ON v.id = il.variant_id
    JOIN products p ON p.id = v.product_id
    GROUP BY p.name, v.sku
    ORDER BY qty_sold DESC
    LIMIT 20
  `);
  res.json(rows);
});

module.exports = router;
