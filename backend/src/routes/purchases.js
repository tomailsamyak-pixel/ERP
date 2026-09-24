const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { round2 } = require('../utils/gst');

const router = express.Router();
router.use(requireAuth);

// POST /purchases/po — create a draft purchase order
router.post('/po', requireRole('owner', 'manager'), async (req, res) => {
  const { po_no, supplier_id, outlet_id, lines = [] } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO purchase_orders (po_no, supplier_id, outlet_id, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [po_no, supplier_id, outlet_id, req.user.id]
    );
    const po = rows[0];
    for (const l of lines) {
      await client.query(
        `INSERT INTO po_lines (po_id, variant_id, qty_ordered, unit_cost) VALUES ($1,$2,$3,$4)`,
        [po.id, l.variant_id, l.qty_ordered, l.unit_cost]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(po);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /purchases/po/:id/approve
router.post('/po/:id/approve', requireRole('owner', 'manager'), async (req, res) => {
  const { rows } = await db.query(
    `UPDATE purchase_orders SET status='approved', approved_by=$2 WHERE id=$1 AND status='draft' RETURNING *`,
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'PO not found or not in draft status' });
  res.json(rows[0]);
});

// POST /purchases/grn — receive goods against a PO, allocate landed cost, post stock-in
router.post('/grn', requireRole('owner', 'manager'), async (req, res) => {
  const { grn_no, po_id, supplier_id, outlet_id, freight = 0, other_charges = 0,
          allocation_method = 'value', lines = [] } = req.body;
  // lines: [{ variant_id, qty_received, unit_cost }]

  const extraCharges = Number(freight) + Number(other_charges);
  const totalValue = lines.reduce((s, l) => s + l.qty_received * l.unit_cost, 0);
  const totalQty = lines.reduce((s, l) => s + l.qty_received, 0);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: grnRows } = await client.query(
      `INSERT INTO grns (grn_no, po_id, supplier_id, outlet_id, freight, other_charges, allocation_method, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [grn_no, po_id, supplier_id, outlet_id, freight, other_charges, allocation_method, req.user.id]
    );
    const grn = grnRows[0];

    for (const l of lines) {
      const share = allocation_method === 'qty'
        ? (totalQty > 0 ? extraCharges * (l.qty_received / totalQty) : 0)
        : (totalValue > 0 ? extraCharges * ((l.qty_received * l.unit_cost) / totalValue) : 0);
      const landedUnitCost = round2(l.unit_cost + (l.qty_received > 0 ? share / l.qty_received : 0));

      await client.query(
        `INSERT INTO grn_lines (grn_id, variant_id, qty_received, unit_cost, landed_unit_cost)
         VALUES ($1,$2,$3,$4,$5)`,
        [grn.id, l.variant_id, l.qty_received, l.unit_cost, landedUnitCost]
      );

      await client.query(
        `INSERT INTO stock_movements (variant_id, outlet_id, qty_delta, reason, ref_type, ref_id, unit_cost, created_by)
         VALUES ($1,$2,$3,'grn','grn',$4,$5,$6)`,
        [l.variant_id, outlet_id, l.qty_received, grn.id, landedUnitCost, req.user.id]
      );

      // Roll the variant's cost_price forward to the latest landed cost (simple, not weighted-average).
      await client.query(`UPDATE variants SET cost_price = $2 WHERE id = $1`, [l.variant_id, landedUnitCost]);
    }

    if (po_id) {
      await client.query(`UPDATE purchase_orders SET status='received' WHERE id=$1`, [po_id]);
    }

    await client.query('COMMIT');
    res.status(201).json(grn);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /purchases/supplier-payment
router.post('/supplier-payment', requireRole('owner', 'manager'), async (req, res) => {
  const { supplier_id, amount, mode, ref_note } = req.body;
  const { rows } = await db.query(
    `INSERT INTO supplier_payments (supplier_id, amount, mode, ref_note) VALUES ($1,$2,$3,$4) RETURNING *`,
    [supplier_id, amount, mode, ref_note]
  );
  res.status(201).json(rows[0]);
});

// GET /purchases/suppliers/:id/ledger
router.get('/suppliers/:id/ledger', async (req, res) => {
  const { rows: grns } = await db.query(
    `SELECT g.id, g.grn_no, g.created_at, COALESCE(SUM(gl.qty_received*gl.landed_unit_cost),0) AS total
     FROM grns g LEFT JOIN grn_lines gl ON gl.grn_id = g.id
     WHERE g.supplier_id = $1 GROUP BY g.id ORDER BY g.created_at`,
    [req.params.id]
  );
  const { rows: payments } = await db.query(
    `SELECT * FROM supplier_payments WHERE supplier_id = $1 ORDER BY created_at`,
    [req.params.id]
  );
  res.json({ grns, payments });
});

module.exports = router;
