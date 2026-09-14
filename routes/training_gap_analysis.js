const express = require('express');
const router = express.Router();

// Same assumption as the other modules: db.js exports a mysql2/promise
// pool, so db.query(sql, params) resolves to [rows, fields].
// If db.js uses the callback-style `mysql` package instead, swap each
// `await db.query(...)` for the callback form.
//
// NOTE: adjust this table name if your actual MySQL table for this
// schema isn't named "training_requirements".
const db = require('../db');

const TABLE = 'training_requirements';

// role_id is a foreign key (per your `describe`), but we don't know
// the referenced table's name or columns. This tries a table called
// "roles" with either a role_name or name column; if that table
// doesn't exist, we fall back to an empty list and the view falls
// back to a plain numeric input instead of crashing.
async function fetchRolesSafely() {
  try {
    const [roles] = await db.query('SELECT * FROM roles ORDER BY role_id');
    return roles;
  } catch (err) {
    return [];
  }
}

// Shared re-render helper: refetches requirements + roles so the page
// still has real data to show alongside a flash/error message.
async function renderWithMessage(res, { flash = null, error = null } = {}) {
  const [requirements] = await db.query(
    `SELECT * FROM ${TABLE} ORDER BY role_id, requirement_id`
  );
  const roles = await fetchRolesSafely();
  res.render('training_gap_analysis', { requirements, roles, flash, error });
}

// Turn a raw MySQL error into a message a user can act on.
function friendlyDbError(err) {
  if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.errno === 1452) {
    return 'That role doesn\u2019t match an existing role. Pick one from the list.';
  }
  if (err.code === 'ER_DUP_ENTRY') {
    return 'That requirement already exists for this role.';
  }
  if (err.code === 'ER_BAD_NULL_ERROR') {
    return 'A required field was left empty.';
  }
  return 'Could not save the training requirement.';
}

// GET /training-management — list all training requirements
// (mounted at "/training-management" in app.js, so this is just "/")
router.get('/', async (req, res) => {
  try {
    await renderWithMessage(res, {});
  } catch (err) {
    console.error('Error loading training requirements:', err);
    res.render('training_gap_analysis', {
      requirements: [],
      roles: [],
      flash: null,
      error: 'Could not load training requirements from the database.',
    });
  }
});

// POST /training-management — create a new training requirement
router.post('/', async (req, res) => {
  const { role_id, required_training, validity_months } = req.body;

  if (!role_id || !required_training) {
    try {
      await renderWithMessage(res, {
        error: 'Role and required training are both required.',
      });
    } catch {
      res.status(500).send('Database error.');
    }
    return;
  }

  try {
    await db.query(
      `INSERT INTO ${TABLE} (role_id, required_training, validity_months)
       VALUES (?, ?, ?)`,
      [role_id, required_training, validity_months || 12]
    );
    res.redirect('/training_gap_analysis');
  } catch (err) {
    console.error('Error creating training requirement:', err);
    try {
      await renderWithMessage(res, { error: friendlyDbError(err) });
    } catch {
      res.status(500).send('Could not save the training requirement.');
    }
  }
});

// POST /training-management/:id/update — edit an existing training requirement
router.post('/:id/update', async (req, res) => {
  const { id } = req.params;
  const { role_id, required_training, validity_months } = req.body;

  try {
    await db.query(
      `UPDATE ${TABLE}
       SET role_id = ?, required_training = ?, validity_months = ?
       WHERE requirement_id = ?`,
      [role_id, required_training, validity_months || 12, id]
    );
    res.redirect('/training_gap_analysis');
  } catch (err) {
    console.error('Error updating training requirement:', err);
    try {
      await renderWithMessage(res, { error: friendlyDbError(err) });
    } catch {
      res.status(500).send('Could not update the training requirement.');
    }
  }
});

// POST /training-management/:id/delete — remove a training requirement
router.post('/:id/delete', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query(`DELETE FROM ${TABLE} WHERE requirement_id = ?`, [id]);
    res.redirect('/training_gap_analysis');
  } catch (err) {
    console.error('Error deleting training requirement:', err);
    res.status(500).send('Could not delete the training requirement.');
  }
});

module.exports = router;