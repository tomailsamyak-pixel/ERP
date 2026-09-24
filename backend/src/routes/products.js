const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /products — catalog with variants and current stock per outlet
router.get('/', async (req, res) => {
  const { rows: products } = await db.query(
    'SELECT * FROM products WHERE active = true ORDER BY name'
  );
  const { rows: variants } = await db.query(`
    SELECT v.*, COALESCE(json_object_agg(sc.outlet_id, sc.qty) FILTER (WHERE sc.outlet_id IS NOT NULL), '{}') AS stock
    FROM variants v
    LEFT JOIN stock_current sc ON sc.variant_id = v.id
    WHERE v.active = true
    GROUP BY v.id
    ORDER BY v.sku
  `);

  const byProduct = {};
  for (const v of variants) {
    (byProduct[v.product_id] ||= []).push(v);
  }
  res.json(products.map((p) => ({ ...p, variants: byProduct[p.id] || [] })));
});

// GET /products/variant/:barcode — scan lookup for POS
router.get('/variant/:barcode', async (req, res) => {
  const { rows } = await db.query(
    `SELECT v.*, p.name AS product_name, p.hsn_code, p.category
     FROM variants v JOIN products p ON p.id = v.product_id
     WHERE v.barcode = $1 AND v.active = true`,
    [req.params.barcode]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No variant with that barcode' });
  res.json(rows[0]);
});

// GET /products/:id/stock — stock ledger for one variant across outlets
router.get('/:variantId/stock', async (req, res) => {
  const { rows } = await db.query(
    `SELECT outlet_id, qty FROM stock_current WHERE variant_id = $1`,
    [req.params.variantId]
  );
  res.json(rows);
});

// POST /products — create a new product + its first variants (owner/manager only)
router.post('/', requireRole('owner', 'manager'), async (req, res) => {
  const { style_code, name, category, fabric, season, hsn_code, base_mrp, variants = [] } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO products (style_code, name, category, fabric, season, hsn_code, base_mrp)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'6109'),$7) RETURNING *`,
      [style_code, name, category, fabric, season, hsn_code, base_mrp]
    );
    const product = rows[0];
    const createdVariants = [];
    for (const v of variants) {
      const { rows: vr } = await client.query(
        `INSERT INTO variants (product_id, sku, size, color, barcode, mrp, cost_price, reorder_level)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,0),COALESCE($8,3)) RETURNING *`,
        [product.id, v.sku, v.size, v.color, v.barcode, v.mrp ?? base_mrp, v.cost_price, v.reorder_level]
      );
      createdVariants.push(vr[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ...product, variants: createdVariants });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /products/transfer — move stock between outlets
router.post('/transfer', requireRole('owner', 'manager'), async (req, res) => {
  const { variant_id, from_outlet, to_outlet, qty } = req.body;
  if (!variant_id || !from_outlet || !to_outlet || !qty || qty <= 0) {
    return res.status(400).json({ error: 'variant_id, from_outlet, to_outlet and a positive qty are required' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO stock_movements (variant_id, outlet_id, qty_delta, reason, ref_type, created_by)
       VALUES ($1,$2,$3,'transfer_out','transfer',$4)`,
      [variant_id, from_outlet, -qty, req.user.id]
    );
    await client.query(
      `INSERT INTO stock_movements (variant_id, outlet_id, qty_delta, reason, ref_type, created_by)
       VALUES ($1,$2,$3,'transfer_in','transfer',$4)`,
      [variant_id, to_outlet, qty, req.user.id]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /products/stocktake — apply a physical-count adjustment
router.post('/stocktake', requireRole('owner', 'manager'), async (req, res) => {
  const { variant_id, outlet_id, counted_qty } = req.body;
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(qty_delta),0)::INT AS qty FROM stock_movements WHERE variant_id=$1 AND outlet_id=$2`,
    [variant_id, outlet_id]
  );
  const current = rows[0].qty;
  const delta = counted_qty - current;
  if (delta === 0) return res.json({ ok: true, delta: 0 });
  await db.query(
    `INSERT INTO stock_movements (variant_id, outlet_id, qty_delta, reason, ref_type, created_by)
     VALUES ($1,$2,$3,'stocktake_adjust','stocktake',$4)`,
    [variant_id, outlet_id, delta, req.user.id]
  );
  res.status(201).json({ ok: true, delta });
});

module.exports = router;
