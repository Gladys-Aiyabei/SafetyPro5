const express = require("express");
const router = express.Router();

// Import MySQL database connection/pool
const db = require("../db");


// =====================================================
// 1. READ ALL INSPECTIONS
// GET /inspections
// =====================================================
router.get("/", async (req, res) => {
    try {

        const [inspections] = await db.query(`
            SELECT
                i.*,
                e.employee_name AS inspector_name
            FROM inspections i
            LEFT JOIN employees e
                ON i.inspector_id = e.employee_id
            ORDER BY i.inspection_date DESC
        `);

        res.render("inspections/index", {
            inspections: inspections,
            title: "Inspections"
        });

    } catch (error) {

        console.error("Error fetching inspections:", error);

        res.status(500).send("Error loading inspections");
    }
});


// =====================================================
// 2. SHOW ADD INSPECTION FORM
// GET /inspections/add
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

        res.render("inspections/add", {
            employees: employees,
            title: "Add Inspection"
        });

    } catch (error) {

        console.error("Error loading add inspection page:", error);

        res.status(500).send("Error loading add inspection page");
    }
});


// =====================================================
// 3. CREATE INSPECTION
// POST /inspections/add
// =====================================================
router.post("/add", async (req, res) => {

    const {
        inspection_date,
        inspection_type,
        location,
        inspector_id,
        findings,
        overall_score,
        status
    } = req.body;

    if (!inspection_date) {
        return res.status(400).send("Inspection date is required.");
    }

    try {

        await db.query(`
            INSERT INTO inspections
                (inspection_date, inspection_type, location,
                 inspector_id, findings, overall_score, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            inspection_date,
            inspection_type || null,
            location || null,
            inspector_id || null,
            findings || null,
            overall_score || null,
            status || null
        ]);

        res.redirect("/inspections");

    } catch (error) {

        console.error("Error creating inspection:", error);

        res.status(500).send(`Error creating inspection: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 4. VIEW ONE INSPECTION
// GET /inspections/view/:id
// =====================================================
router.get("/view/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [inspections] = await db.query(`
            SELECT
                i.*,
                e.employee_name AS inspector_name
            FROM inspections i
            LEFT JOIN employees e
                ON i.inspector_id = e.employee_id
            WHERE i.inspection_id = ?
        `, [id]);

        if (inspections.length === 0) {
            return res.status(404).send("Inspection not found");
        }

        res.render("inspections/view", {
            inspection: inspections[0],
            title: "View Inspection"
        });

    } catch (error) {

        console.error("Error viewing inspection:", error);

        res.status(500).send("Error viewing inspection");
    }
});


// =====================================================
// 5. SHOW EDIT INSPECTION FORM
// GET /inspections/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [inspections] = await db.query(`
            SELECT *
            FROM inspections
            WHERE inspection_id = ?
        `, [id]);

        if (inspections.length === 0) {
            return res.status(404).send("Inspection not found");
        }

        const [employees] = await db.query(`
            SELECT
                employee_id,
                employee_name
            FROM employees
            ORDER BY employee_name ASC
        `);

        res.render("inspections/edit", {
            inspection: inspections[0],
            employees: employees,
            title: "Edit Inspection"
        });

    } catch (error) {

        console.error("Error loading edit inspection page:", error);

        res.status(500).send("Error loading edit inspection page");
    }
});


// =====================================================
// 6. UPDATE INSPECTION
// POST /inspections/edit/:id
// =====================================================
router.post("/edit/:id", async (req, res) => {

    const { id } = req.params;

    const {
        inspection_date,
        inspection_type,
        location,
        inspector_id,
        findings,
        overall_score,
        status
    } = req.body;

    if (!inspection_date) {
        return res.status(400).send("Inspection date is required.");
    }

    try {

        const [result] = await db.query(`
            UPDATE inspections
            SET
                inspection_date = ?,
                inspection_type = ?,
                location = ?,
                inspector_id = ?,
                findings = ?,
                overall_score = ?,
                status = ?
            WHERE inspection_id = ?
        `, [
            inspection_date,
            inspection_type || null,
            location || null,
            inspector_id || null,
            findings || null,
            overall_score || null,
            status || null,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Inspection not found");
        }

        res.redirect("/inspections");

    } catch (error) {

        console.error("Error updating inspection:", error);

        res.status(500).send(`Error updating inspection: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 7. DELETE INSPECTION
// POST /inspections/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [result] = await db.query(`
            DELETE FROM inspections
            WHERE inspection_id = ?
        `, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Inspection not found");
        }

        res.redirect("/inspections");

    } catch (error) {

        console.error("Error deleting inspection:", error);

        res.status(500).send("Error deleting inspection");
    }
});


module.exports = router;