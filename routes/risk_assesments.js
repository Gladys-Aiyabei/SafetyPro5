const express = require('express');
const router = express.Router();

// Same assumption as permits.js / ppe.js: db.js exports a mysql2/promise
// pool, so db.query(sql, params) resolves to [rows, fields].
// If db.js uses the callback-style `mysql` package instead, swap each
// `await db.query(...)` for the callback form.
//
// NOTE: adjust this table name if your actual MySQL table isn't named
// "risk_assessments" (the schema you shared didn't include the table
// name itself, only its columns).
const db = require('../db');

const TABLE = 'risk_assessments';

// Recompute score/level server-side too, so a value never gets stored
// out of sync with likelihood/severity even if the client is bypassed.
function levelFor(score) {
  if (score <= 4) return 'Low';
  if (score <= 9) return 'Medium';
  if (score <= 15) return 'High';
  return 'Critical';
}

// GET /risk-assessments — list all risk assessments
// (mounted at "/risk-assessments" in app.js, so this is just "/")
router.get('/', async (req, res) => {
  try {
    const [risks] = await db.query(
      `SELECT * FROM ${TABLE} ORDER BY assessment_date DESC, risk_id DESC`
    );
    res.render('risk_assesments', { risks, flash: null, error: null });
  } catch (err) {
    console.error('Error loading risk assessments:', err);
    res.render('risk_assesments', {
      risks: [],
      flash: null,
      error: 'Could not load risk assessments from the database.',
    });
  }
});

// POST /risk-assessments — create a new risk assessment
router.post('/', async (req, res) => {
  const {
    activity,
    hazard,
    consequence,
    likelihood,
    severity,
    control_measures,
    responsible_person,
    assessment_date,
  } = req.body;

  if (!activity) {
    try {
      const [risks] = await db.query(
        `SELECT * FROM ${TABLE} ORDER BY assessment_date DESC, risk_id DESC`
      );
      return res.render('risk_assesments', {
        risks,
        flash: null,
        error: 'Activity is required.',
      });
    } catch (err) {
      return res.status(500).send('Database error.');
    }
  }

  const l = Number(likelihood) || 1;
  const s = Number(severity) || 1;
  const score = l * s;
  const level = levelFor(score);

  try {
    await db.query(
      `INSERT INTO ${TABLE}
        (activity, hazard, consequence, likelihood, severity, risk_score, risk_level, control_measures, responsible_person, assessment_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        activity,
        hazard || null,
        consequence || null,
        l,
        s,
        score,
        level,
        control_measures || null,
        responsible_person || null,
        assessment_date || null,
      ]
    );
    res.redirect('/risk-assessments');
  } catch (err) {
    console.error('Error creating risk assessment:', err);
    res.status(500).send('Could not save the assessment.');
  }
});

// POST /risk-assessments/:id/update — edit an existing risk assessment
router.post('/:id/update', async (req, res) => {
  const { id } = req.params;
  const {
    activity,
    hazard,
    consequence,
    likelihood,
    severity,
    control_measures,
    responsible_person,
    assessment_date,
  } = req.body;

  const l = Number(likelihood) || 1;
  const s = Number(severity) || 1;
  const score = l * s;
  const level = levelFor(score);

  try {
    await db.query(
      `UPDATE ${TABLE} SET
        activity = ?,
        hazard = ?,
        consequence = ?,
        likelihood = ?,
        severity = ?,
        risk_score = ?,
        risk_level = ?,
        control_measures = ?,
        responsible_person = ?,
        assessment_date = ?
       WHERE risk_id = ?`,
      [
        activity,
        hazard || null,
        consequence || null,
        l,
        s,
        score,
        level,
        control_measures || null,
        responsible_person || null,
        assessment_date || null,
        id,
      ]
    );
    res.redirect('/risk-assessments');
  } catch (err) {
    console.error('Error updating risk assessment:', err);
    res.status(500).send('Could not update the assessment.');
  }
});

// POST /risk-assessments/:id/delete — remove a risk assessment
router.post('/:id/delete', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query(`DELETE FROM ${TABLE} WHERE risk_id = ?`, [id]);
    res.redirect('/risk-assessments');
  } catch (err) {
    console.error('Error deleting risk assessment:', err);
    res.status(500).send('Could not delete the assessment.');
  }
});

module.exports = router;