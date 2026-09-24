const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { q } = req.query;
  const { rows } = q
    ? await db.query(`SELECT * FROM customers WHERE phone ILIKE $1 OR name ILIKE $1 ORDER BY name LIMIT 50`, [`%${q}%`])
    : await db.query(`SELECT * FROM customers ORDER BY created_at DESC LIMIT 50`);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, phone, gstin, state_code, measurements } = req.body;
  const { rows } = await db.query(
    `INSERT INTO customers (name, phone, gstin, state_code, measurements)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, phone, gstin, state_code, measurements ? JSON.stringify(measurements) : null]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const { measurements, loyalty_points, store_credit } = req.body;
  const { rows } = await db.query(
    `UPDATE customers SET
       measurements = COALESCE($2, measurements),
       loyalty_points = COALESCE($3, loyalty_points),
       store_credit = COALESCE($4, store_credit)
     WHERE id = $1 RETURNING *`,
    [req.params.id, measurements ? JSON.stringify(measurements) : null, loyalty_points, store_credit]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

router.get('/:id/invoices', async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM invoices WHERE customer_id=$1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
});

module.exports = router;
