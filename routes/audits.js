const express = require("express");
const router = express.Router();

// Import MySQL database connection/pool
const db = require("../db");


// =====================================================
// 1. READ ALL AUDITS
// GET /audits
// =====================================================
router.get("/", async (req, res) => {
    try {

        const [audits] = await db.query(`
            SELECT
                a.*,
                d.department_name,
                d.location
            FROM audits a
            LEFT JOIN departments d
                ON a.department_id = d.department_id
            ORDER BY a.audit_id DESC
        `);

        res.render("audits/index", {
            audits: audits,
            title: "Audits"
        });

    } catch (error) {

        console.error("Error fetching audits:", error);

        res.status(500).send("Error loading audits");
    }
});


// =====================================================
// 2. SHOW ADD AUDIT FORM
// GET /audits/add
// =====================================================
router.get("/add", async (req, res) => {

    console.log("OPENING ADD AUDIT PAGE");

    try {

        const [departments] = await db.query(`
            SELECT
                department_id,
                department_name,
                location
            FROM departments
            ORDER BY department_name ASC
        `);

        console.log("DEPARTMENTS FOUND:", departments.length);

        res.render("audits/add", {
            departments: departments,
            title: "Add Audit"
        });

    } catch (error) {

        console.error("================================");
        console.error("ADD AUDIT ERROR:", error.message);
        console.error(error.stack);
        console.error("================================");

        res.status(500).send(`
            <h2>Add Audit Error</h2>
            <pre>${error.stack}</pre>
        `);
    }
});


// =====================================================
// 3. CREATE AUDIT
// POST /audits/add
// =====================================================
router.post("/add", async (req, res) => {

    const {
        audit_date,
        audit_type,
        department_id,
        auditor,
        findings,
        score,
        status
    } = req.body;

    try {

        await db.query(`
            INSERT INTO audits
                (audit_date, audit_type, department_id, auditor, findings, score, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            audit_date,
            audit_type,
            department_id,
            auditor,
            findings,
            score,
            status
        ]);

        res.redirect("/audits");

    } catch (error) {

        console.error("Error creating audit:", error);

        res.status(500).send("Error creating audit");
    }
});


// =====================================================
// 4. VIEW ONE AUDIT
// GET /audits/view/:id
// =====================================================
router.get("/view/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [audits] = await db.query(`
            SELECT
                a.*,
                d.department_name,
                d.location
            FROM audits a
            LEFT JOIN departments d
                ON a.department_id = d.department_id
            WHERE a.audit_id = ?
        `, [id]);

        if (audits.length === 0) {
            return res.status(404).send("Audit not found");
        }

        res.render("audits/view", {
            audit: audits[0],
            title: "View Audit"
        });

    } catch (error) {

        console.error("Error viewing audit:", error);

        res.status(500).send("Error viewing audit");
    }
});


// =====================================================
// 5. SHOW EDIT AUDIT FORM
// GET /audits/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    const { id } = req.params;

    try {

        // Get the audit
        const [audits] = await db.query(`
            SELECT *
            FROM audits
            WHERE audit_id = ?
        `, [id]);

        if (audits.length === 0) {
            return res.status(404).send("Audit not found");
        }

        // Get departments for dropdown
        const [departments] = await db.query(`
            SELECT
                department_id,
                department_name,
                location
            FROM departments
            ORDER BY department_name ASC
        `);

        res.render("audits/edit", {
            audit: audits[0],
            departments: departments,
            title: "Edit Audit"
        });

    } catch (error) {

        console.error("Error loading edit audit page:", error);

        res.status(500).send(
            "Error loading edit audit page"
        );
    }
});


// =====================================================
// 6. UPDATE AUDIT
// POST /audits/edit/:id
// =====================================================
router.post("/edit/:id", async (req, res) => {

    const { id } = req.params;

    const {
        audit_date,
        audit_type,
        department_id,
        auditor,
        findings,
        score,
        status
    } = req.body;

    try {

        const [result] = await db.query(`
            UPDATE audits
            SET
                audit_date = ?,
                audit_type = ?,
                department_id = ?,
                auditor = ?,
                findings = ?,
                score = ?,
                status = ?
            WHERE audit_id = ?
        `, [
            audit_date,
            audit_type,
            department_id,
            auditor,
            findings,
            score,
            status,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Audit not found");
        }

        res.redirect("/audits");

    } catch (error) {

        console.error("Error updating audit:", error);

        res.status(500).send(
            "Error updating audit"
        );
    }
});


// =====================================================
// 7. DELETE AUDIT
// POST /audits/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [result] = await db.query(`
            DELETE FROM audits
            WHERE audit_id = ?
        `, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Audit not found");
        }

        res.redirect("/audits");

    } catch (error) {

        console.error("Error deleting audit:", error);

        res.status(500).send(
            "Error deleting audit"
        );
    }
});


module.exports = router;