const express = require("express");
const router = express.Router();

// Import MySQL database connection/pool
const db = require("../db");


// =====================================================
// 1. READ ALL INCIDENTS
// GET /incidents
// =====================================================
router.get("/", async (req, res) => {
    try {

        const [incidents] = await db.query(`
            SELECT
                i.*,
                e.employee_name AS reported_by_name
            FROM incidents i
            LEFT JOIN employees e
                ON i.reported_by = e.employee_id
            ORDER BY i.incident_date DESC
        `);

        res.render("incidents/index", {
            incidents: incidents,
            title: "Incidents"
        });

    } catch (error) {

        console.error("Error fetching incidents:", error);

        res.status(500).send("Error loading incidents");
    }
});


// =====================================================
// 2. SHOW ADD INCIDENT FORM
// GET /incidents/add
// =====================================================
router.get("/add", async (req, res) => {

    try {

        const [employees] = await db.query(`
            SELECT
                employee_id,
                employee_name
            FROM employees
            ORDER BY employee_name ASC
        `);

        res.render("incidents/add", {
            employees: employees,
            title: "Add Incident"
        });

    } catch (error) {

        console.error("Error loading add incident page:", error);

        res.status(500).send("Error loading add incident page");
    }
});


// =====================================================
// 3. CREATE INCIDENT
// POST /incidents/add
// =====================================================
router.post("/add", async (req, res) => {

    const {
        incident_date,
        incident_type,
        severity,
        location,
        description,
        immediate_action,
        reported_by,
        status
    } = req.body;

    if (!incident_date) {
        return res.status(400).send("Incident date is required.");
    }

    try {

        await db.query(`
            INSERT INTO incidents
                (incident_date, incident_type, severity, location,
                 description, immediate_action, reported_by, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            incident_date,
            incident_type || null,
            severity || null,
            location || null,
            description || null,
            immediate_action || null,
            reported_by || null,
            status || "Open"
        ]);

        res.redirect("/incidents");

    } catch (error) {

        console.error("Error creating incident:", error);

        res.status(500).send(`Error creating incident: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 4. VIEW ONE INCIDENT
// GET /incidents/view/:id
// =====================================================
router.get("/view/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [incidents] = await db.query(`
            SELECT
                i.*,
                e.employee_name AS reported_by_name
            FROM incidents i
            LEFT JOIN employees e
                ON i.reported_by = e.employee_id
            WHERE i.incident_id = ?
        `, [id]);

        if (incidents.length === 0) {
            return res.status(404).send("Incident not found");
        }

        res.render("incidents/view", {
            incident: incidents[0],
            title: "View Incident"
        });

    } catch (error) {

        console.error("Error viewing incident:", error);

        res.status(500).send("Error viewing incident");
    }
});


// =====================================================
// 5. SHOW EDIT INCIDENT FORM
// GET /incidents/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [incidents] = await db.query(`
            SELECT *
            FROM incidents
            WHERE incident_id = ?
        `, [id]);

        if (incidents.length === 0) {
            return res.status(404).send("Incident not found");
        }

        const [employees] = await db.query(`
            SELECT
                employee_id,
                employee_name
            FROM employees
            ORDER BY employee_name ASC
        `);

        res.render("incidents/edit", {
            incident: incidents[0],
            employees: employees,
            title: "Edit Incident"
        });

    } catch (error) {

        console.error("Error loading edit incident page:", error);

        res.status(500).send("Error loading edit incident page");
    }
});


// =====================================================
// 6. UPDATE INCIDENT
// POST /incidents/edit/:id
// =====================================================
router.post("/edit/:id", async (req, res) => {

    const { id } = req.params;

    const {
        incident_date,
        incident_type,
        severity,
        location,
        description,
        immediate_action,
        reported_by,
        status
    } = req.body;

    if (!incident_date) {
        return res.status(400).send("Incident date is required.");
    }

    try {

        const [result] = await db.query(`
            UPDATE incidents
            SET
                incident_date = ?,
                incident_type = ?,
                severity = ?,
                location = ?,
                description = ?,
                immediate_action = ?,
                reported_by = ?,
                status = ?
            WHERE incident_id = ?
        `, [
            incident_date,
            incident_type || null,
            severity || null,
            location || null,
            description || null,
            immediate_action || null,
            reported_by || null,
            status || "Open",
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Incident not found");
        }

        res.redirect("/incidents");

    } catch (error) {

        console.error("Error updating incident:", error);

        res.status(500).send(`Error updating incident: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 7. DELETE INCIDENT
// POST /incidents/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [result] = await db.query(`
            DELETE FROM incidents
            WHERE incident_id = ?
        `, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Incident not found");
        }

        res.redirect("/incidents");

    } catch (error) {

        console.error("Error deleting incident:", error);

        res.status(500).send("Error deleting incident");
    }
});


module.exports = router;