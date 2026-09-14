const express = require('express');
const router = express.Router();

// Same assumption as permits.js: db.js exports a mysql2/promise pool,
// so db.query(sql, params) resolves to [rows, fields].
// If db.js uses the callback-style `mysql` package instead, swap each
// `await db.query(...)` for the callback form.
const db = require('../db');

// GET /ppe — list all PPE inventory items
// (mounted at "/ppe" in app.js, so this is just "/")
router.get('/', async (req, res) => {
  try {
    const [items] = await db.query(
      'SELECT * FROM ppe_inventory ORDER BY item_name ASC'
    );
    res.render('ppe', { items, flash: null, error: null });
  } catch (err) {
    console.error('Error loading PPE inventory:', err);
    res.render('ppe', {
      items: [],
      flash: null,
      error: 'Could not load PPE inventory from the database.',
    });
  }
});

// POST /ppe — add a new PPE item
router.post('/', async (req, res) => {
  const { item_name, category, quantity, department, status, expiry_date } =
    req.body;

  if (!item_name) {
    try {
      const [items] = await db.query(
        'SELECT * FROM ppe_inventory ORDER BY item_name ASC'
      );
      return res.render('ppe', {
        items,
        flash: null,
        error: 'Item name is required.',
      });
    } catch (err) {
      return res.status(500).send('Database error.');
    }
  }

  try {
    await db.query(
      `INSERT INTO ppe_inventory
        (item_name, category, quantity, department, status, expiry_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        item_name,
        category || null,
        quantity || 0,
        department || null,
        status || 'Available',
        expiry_date || null,
      ]
    );
    res.redirect('/ppe');
  } catch (err) {
    console.error('Error creating PPE item:', err);
    res.status(500).send('Could not save the item.');
  }
});

// POST /ppe/:id/update — edit an existing PPE item
router.post('/:id/update', async (req, res) => {
  const { id } = req.params;
  const { item_name, category, quantity, department, status, expiry_date } =
    req.body;

  try {
    await db.query(
      `UPDATE ppe_inventory SET
        item_name = ?,
        category = ?,
        quantity = ?,
        department = ?,
        status = ?,
        expiry_date = ?
       WHERE id = ?`,
      [
        item_name,
        category || null,
        quantity || 0,
        department || null,
        status || 'Available',
        expiry_date || null,
        id,
      ]
    );
    res.redirect('/ppe');
  } catch (err) {
    console.error('Error updating PPE item:', err);
    res.status(500).send('Could not update the item.');
  }
});

// POST /ppe/:id/delete — remove a PPE item
router.post('/:id/delete', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM ppe_inventory WHERE id = ?', [id]);
    res.redirect('/ppe');
  } catch (err) {
    console.error('Error deleting PPE item:', err);
    res.status(500).send('Could not delete the item.');
  }
});

module.exports = router;