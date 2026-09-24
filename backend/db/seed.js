// Populates a fresh database with enough data to log in and test end-to-end.
// Run with: npm run seed  (after `npm run migrate`)
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO outlets (id, name, address, state_code, gstin) VALUES
      ('FL', 'Flagship Store', 'Shop 12, Central Market', '24', '24AABCT4821K1Z7'),
      ('CM', 'City Mall Outlet', 'Unit 4, City Mall', '24', '24AABCT4821K1Z7')
      ON CONFLICT (id) DO NOTHING;
    `);

    const ownerPin = await bcrypt.hash('1234', 10);
    await client.query(
      `INSERT INTO users (name, phone, pin_hash, role, home_outlet)
       VALUES ('Owner', '9999900000', $1, 'owner', 'FL')
       ON CONFLICT (phone) DO NOTHING`,
      [ownerPin]
    );
    const managerPin = await bcrypt.hash('1234', 10);
    await client.query(
      `INSERT INTO users (name, phone, pin_hash, role, home_outlet)
       VALUES ('Manager', '9999900001', $1, 'manager', 'FL')
       ON CONFLICT (phone) DO NOTHING`,
      [managerPin]
    );
    const cashierPin = await bcrypt.hash('1111', 10);
    await client.query(
      `INSERT INTO users (name, phone, pin_hash, role, home_outlet)
       VALUES ('Cashier', '9999900002', $1, 'cashier', 'FL')
       ON CONFLICT (phone) DO NOTHING`,
      [cashierPin]
    );

    const { rows: supRows } = await client.query(
      `INSERT INTO suppliers (name, gstin, phone) VALUES ('Apex Textiles', '24AAAAA0000A1Z5', '9800000000')
       RETURNING id`
    );
    const supplierId = supRows[0].id;

    const products = [
      { style_code: 'TE-SH-001', name: 'Classic Cotton Shirt', category: 'shirt', hsn_code: '6205', base_mrp: 1299 },
      { style_code: 'TE-TS-001', name: 'Everyday Crew Tee', category: 'tee', hsn_code: '6109', base_mrp: 599 },
      { style_code: 'TE-TR-001', name: 'Slim Fit Chinos', category: 'trouser', hsn_code: '6203', base_mrp: 1799 },
      { style_code: 'TE-BL-001', name: 'Tailored Blazer', category: 'blazer', hsn_code: '6203', base_mrp: 4499 },
    ];
    const sizes = ['S', 'M', 'L', 'XL'];
    const colors = ['Black', 'Navy', 'White'];

    let barcodeSeq = 100000;
    for (const p of products) {
      const { rows } = await client.query(
        `INSERT INTO products (style_code, name, category, hsn_code, base_mrp) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [p.style_code, p.name, p.category, p.hsn_code, p.base_mrp]
      );
      const productId = rows[0].id;

      for (const size of sizes) {
        for (const color of colors) {
          barcodeSeq += 1;
          const sku = `${p.style_code}-${size}-${color.slice(0, 3).toUpperCase()}`;
          const { rows: vRows } = await client.query(
            `INSERT INTO variants (product_id, sku, size, color, barcode, mrp, cost_price, reorder_level)
             VALUES ($1,$2,$3,$4,$5,$6,$7,3) RETURNING id`,
            [productId, sku, size, color, String(barcodeSeq), p.base_mrp, Math.round(p.base_mrp * 0.45)]
          );
          const variantId = vRows[0].id;

          // Opening stock at the flagship outlet only, via GRN-style entry.
          const openQty = 8;
          await client.query(
            `INSERT INTO stock_movements (variant_id, outlet_id, qty_delta, reason, unit_cost)
             VALUES ($1,'FL',$2,'opening',$3)`,
            [variantId, openQty, Math.round(p.base_mrp * 0.45)]
          );
        }
      }
    }

    await client.query(
      `INSERT INTO customers (name, phone, state_code) VALUES ('Walk-in Customer', '0000000000', '24')
       ON CONFLICT (phone) DO NOTHING`
    );

    await client.query('COMMIT');
    console.log('Seed complete.');
    console.log('Logins  ->  Owner: 9999900000 / PIN 1234   Manager: 9999900001 / PIN 1234   Cashier: 9999900002 / PIN 1111');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
