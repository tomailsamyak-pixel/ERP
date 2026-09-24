const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

// POST /auth/login  { phone, pin }
router.post('/login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: 'phone and pin are required' });

  const { rows } = await db.query(
    'SELECT * FROM users WHERE phone = $1 AND active = true',
    [phone]
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid phone or PIN' });

  const ok = await bcrypt.compare(pin, user.pin_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid phone or PIN' });

  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role, home_outlet: user.home_outlet },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, home_outlet: user.home_outlet },
  });
});

module.exports = router;
