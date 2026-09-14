const express = require('express');
const router = express.Router();

// Your app.js already does: const db = require("./db");
// This assumes db.js exports a mysql2/promise pool, i.e.
//   const mysql = require('mysql2/promise');
//   module.exports = mysql.createPool({ ...connection config... });
// so that db.query(sql, params) resolves to [rows, fields].
//
// If your db.js instead uses the plain callback-style `mysql` package,
// swap every `await db.query(...)` below for the callback form:
//   db.query(sql, params, (err, rows) => { ... });
const db = require('../db');

// GET /permits — list all permits
// (mounted at "/permits" in app.js, so this is just "/")
router.get('/', async (req, res) => {
  try {
    const [permits] = await db.query(
      'SELECT * FROM permits ORDER BY issue_date DESC'
    );
    res.render('permits', { permits, flash: null, error: null });
  } catch (err) {
    console.error('Error loading permits:', err);
    res.render('permits', {
      permits: [],
      flash: null,
      error: 'Could not load permits from the database.',
    });
  }
});

// POST /permits — create a new permit
router.post('/', async (req, res) => {
  const {
    permit_number,
    permit_type,
    work_description,
    location,
    requested_by,
    approved_by,
    issue_date,
    expiry_date,
    status,
  } = req.body;

  if (!permit_number || !permit_type) {
    try {
      const [permits] = await db.query(
        'SELECT * FROM permits ORDER BY issue_date DESC'
      );
      return res.render('permits', {
        permits,
        flash: null,
        error: 'Permit number and permit type are required.',
      });
    } catch (err) {
      return res.status(500).send('Database error.');
    }
  }

  try {
    await db.query(
      `INSERT INTO permits
        (permit_number, permit_type, work_description, location, requested_by, approved_by, issue_date, expiry_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        permit_number,
        permit_type,
        work_description || null,
        location || null,
        requested_by || null,
        approved_by || null,
        issue_date || null,
        expiry_date || null,
        status || 'Pending',
      ]
    );
    res.redirect('/permits');
  } catch (err) {
    console.error('Error creating permit:', err);
    // permit_number has a UNIQUE constraint — surface a clear message for that case
    const message =
      err.code === 'ER_DUP_ENTRY'
        ? 'A permit with that permit number already exists.'
        : 'Could not save the permit.';
    try {
      const [permits] = await db.query(
        'SELECT * FROM permits ORDER BY issue_date DESC'
      );
      res.render('permits', { permits, flash: null, error: message });
    } catch {
      res.status(500).send('Database error.');
    }
  }
});

// POST /permits/:id/update — edit an existing permit
router.post('/:id/update', async (req, res) => {
  const { id } = req.params;
  const {
    permit_number,
    permit_type,
    work_description,
    location,
    requested_by,
    approved_by,
    issue_date,
    expiry_date,
    status,
  } = req.body;

  try {
    await db.query(
      `UPDATE permits SET
        permit_number = ?,
        permit_type = ?,
        work_description = ?,
        location = ?,
        requested_by = ?,
        approved_by = ?,
        issue_date = ?,
        expiry_date = ?,
        status = ?
       WHERE permit_id = ?`,
      [
        permit_number,
        permit_type,
        work_description || null,
        location || null,
        requested_by || null,
        approved_by || null,
        issue_date || null,
        expiry_date || null,
        status || 'Pending',
        id,
      ]
    );
    res.redirect('/permits');
  } catch (err) {
    console.error('Error updating permit:', err);
    res.status(500).send('Could not update the permit.');
  }
});

// POST /permits/:id/delete — remove a permit
router.post('/:id/delete', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM permits WHERE permit_id = ?', [id]);
    res.redirect('/permits');
  } catch (err) {
    console.error('Error deleting permit:', err);
    res.status(500).send('Could not delete the permit.');
  }
});

module.exports = router;