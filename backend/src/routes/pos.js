const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { taxLine, round2 } = require('../utils/gst');

const router = express.Router();
router.use(requireAuth);

// Look up an outlet's GST state code once per request as needed.
async function outletState(client, outletId) {
  const { rows } = await client.query('SELECT state_code FROM outlets WHERE id=$1', [outletId]);
  if (!rows[0]) throw new Error('Unknown outlet');
  return rows[0].state_code;
}

// POST /pos/invoices — create a bill
// body: { invoice_no, outlet_id, customer_id?, lines:[{variant_id, qty, mrp, line_discount}], payments:[{mode,amount}] }
router.post('/invoices', async (req, res) => {
  const { invoice_no, outlet_id, customer_id, lines = [], payments = [] } = req.body;
  if (!lines.length) return res.status(400).json({ error: 'At least one line item is required' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const shopState = await outletState(client, outlet_id);
    let customerState = shopState;
    if (customer_id) {
      const { rows } = await client.query('SELECT state_code FROM customers WHERE id=$1', [customer_id]);
      if (rows[0]?.state_code) customerState = rows[0].state_code;
    }

    let subtotal = 0, discountTotal = 0, taxableTotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0;
    const computedLines = [];

    for (const l of lines) {
      // Confirm stock before committing to the sale.
      const { rows: stockRows } = await client.query(
        `SELECT COALESCE(SUM(qty_delta),0)::INT AS qty FROM stock_movements WHERE variant_id=$1 AND outlet_id=$2`,
        [l.variant_id, outlet_id]
      );
      if ((stockRows[0]?.qty ?? 0) < l.qty) {
        throw new Error(`Insufficient stock for variant ${l.variant_id} at ${outlet_id}`);
      }

      const tax = taxLine({
        mrp: l.mrp, qty: l.qty, lineDiscount: l.line_discount || 0,
        shopState, customerState,
      });
      subtotal += l.mrp * l.qty;
      discountTotal += l.line_discount || 0;
      taxableTotal += tax.taxableValue;
      cgstTotal += tax.cgst; sgstTotal += tax.sgst; igstTotal += tax.igst;
      computedLines.push({ ...l, tax });
    }

    const grandTotal = round2(taxableTotal + cgstTotal + sgstTotal + igstTotal);
    const paidTotal = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
    const status = paidTotal + 0.01 >= grandTotal ? 'paid' : 'partial';

    const { rows: invRows } = await client.query(
      `INSERT INTO invoices (invoice_no, outlet_id, customer_id, cashier_id, status,
         subtotal, discount_total, taxable_total, cgst_total, sgst_total, igst_total, grand_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [invoice_no, outlet_id, customer_id || null, req.user.id, status,
       round2(subtotal), round2(discountTotal), round2(taxableTotal),
       round2(cgstTotal), round2(sgstTotal), round2(igstTotal), grandTotal]
    );
    const invoice = invRows[0];

    for (const l of computedLines) {
      await client.query(
        `INSERT INTO invoice_lines (invoice_id, variant_id, qty, mrp, line_discount, taxable_value, gst_rate, cgst, sgst, igst)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [invoice.id, l.variant_id, l.qty, l.mrp, l.line_discount || 0,
         l.tax.taxableValue, l.tax.gstRate, l.tax.cgst, l.tax.sgst, l.tax.igst]
      );
      await client.query(
        `INSERT INTO stock_movements (variant_id, outlet_id, qty_delta, reason, ref_type, ref_id, created_by)
         VALUES ($1,$2,$3,'sale','invoice',$4,$5)`,
        [l.variant_id, outlet_id, -l.qty, invoice.id, req.user.id]
      );
    }

    for (const p of payments) {
      await client.query(
        `INSERT INTO payments (invoice_id, mode, amount) VALUES ($1,$2,$3)`,
        [invoice.id, p.mode, p.amount]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ...invoice, lines: computedLines });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /pos/invoices/:id
router.get('/invoices/:id', async (req, res) => {
  const { rows: invRows } = await db.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
  if (!invRows[0]) return res.status(404).json({ error: 'Not found' });
  const { rows: lines } = await db.query('SELECT * FROM invoice_lines WHERE invoice_id=$1', [req.params.id]);
  const { rows: pays } = await db.query('SELECT * FROM payments WHERE invoice_id=$1', [req.params.id]);
  res.json({ ...invRows[0], lines, payments: pays });
});

// POST /pos/invoices/:id/void — manager/owner only
router.post('/invoices/:id/void', requireRole('owner', 'manager'), async (req, res) => {
  const { reason } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE invoices SET status='void', voided_at=now(), void_reason=$2
       WHERE id=$1 AND status <> 'void' RETURNING *`,
      [req.params.id, reason]
    );
    if (!rows[0]) throw new Error('Invoice not found or already void');
    const { rows: lines } = await client.query('SELECT * FROM invoice_lines WHERE invoice_id=$1', [req.params.id]);
    for (const l of lines) {
      await client.query(
        `INSERT INTO stock_movements (variant_id, outlet_id, qty_delta, reason, ref_type, ref_id, created_by)
         VALUES ($1,$2,$3,'sale_return','invoice',$4,$5)`,
        [l.variant_id, rows[0].outlet_id, l.qty, req.params.id, req.user.id]
      );
    }
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /pos/credit-notes — return or exchange against an original invoice
router.post('/credit-notes', async (req, res) => {
  const { cn_no, original_invoice_id, reason, amount, variant_id, qty, outlet_id } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO credit_notes (cn_no, original_invoice_id, reason, amount, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [cn_no, original_invoice_id, reason, amount, req.user.id]
    );
    if (variant_id && qty && outlet_id) {
      await client.query(
        `INSERT INTO stock_movements (variant_id, outlet_id, qty_delta, reason, ref_type, ref_id, created_by)
         VALUES ($1,$2,$3,$4,'invoice',$5,$6)`,
        [variant_id, outlet_id, qty, reason === 'exchange' ? 'exchange_in' : 'sale_return', original_invoice_id, req.user.id]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
