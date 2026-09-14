const express = require("express");
const router = express.Router();

// Import MySQL database connection/pool
const db = require("../db");


// =====================================================
// 1. READ ALL DEPARTMENTS
// GET /departments
// =====================================================
router.get("/", async (req, res) => {
    try {

        const [departments] = await db.query(`
            SELECT *
            FROM departments
            ORDER BY department_name ASC
        `);

        res.render("departments/index", {
            departments: departments,
            title: "Departments"
        });

    } catch (error) {

        console.error("Error fetching departments:", error);

        res.status(500).send("Error loading departments");
    }
});


// =====================================================
// 2. SHOW ADD DEPARTMENT FORM
// GET /departments/add
// =====================================================
router.get("/add", (req, res) => {

    res.render("departments/add", {
        title: "Add Department"
    });

});


// =====================================================
// 3. CREATE DEPARTMENT
// POST /departments/add
// =====================================================
router.post("/add", async (req, res) => {

    const {
        department_name,
        location
    } = req.body;

    if (!department_name || department_name.trim() === "") {
        return res.status(400).send("Department name is required.");
    }

    try {

        await db.query(`
            INSERT INTO departments
                (department_name, location)
            VALUES (?, ?)
        `, [
            department_name,
            location || null
        ]);

        res.redirect("/departments");

    } catch (error) {

        console.error("Error creating department:", error);

        res.status(500).send(`Error creating department: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 4. VIEW ONE DEPARTMENT
// GET /departments/view/:id
// =====================================================
router.get("/view/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [departments] = await db.query(`
            SELECT *
            FROM departments
            WHERE department_id = ?
        `, [id]);

        if (departments.length === 0) {
            return res.status(404).send("Department not found");
        }

        res.render("departments/view", {
            department: departments[0],
            title: "View Department"
        });

    } catch (error) {

        console.error("Error viewing department:", error);

        res.status(500).send("Error viewing department");
    }
});


// =====================================================
// 5. SHOW EDIT DEPARTMENT FORM
// GET /departments/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [departments] = await db.query(`
            SELECT *
            FROM departments
            WHERE department_id = ?
        `, [id]);

        if (departments.length === 0) {
            return res.status(404).send("Department not found");
        }

        res.render("departments/edit", {
            department: departments[0],
            title: "Edit Department"
        });

    } catch (error) {

        console.error("Error loading edit department page:", error);

        res.status(500).send("Error loading edit department page");
    }
});


// =====================================================
// 6. UPDATE DEPARTMENT
// POST /departments/edit/:id
// =====================================================
router.post("/edit/:id", async (req, res) => {

    const { id } = req.params;

    const {
        department_name,
        location
    } = req.body;

    if (!department_name || department_name.trim() === "") {
        return res.status(400).send("Department name is required.");
    }

    try {

        const [result] = await db.query(`
            UPDATE departments
            SET
                department_name = ?,
                location = ?
            WHERE department_id = ?
        `, [
            department_name,
            location || null,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Department not found");
        }

        res.redirect("/departments");

    } catch (error) {

        console.error("Error updating department:", error);

        res.status(500).send(`Error updating department: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 7. DELETE DEPARTMENT
// POST /departments/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [result] = await db.query(`
            DELETE FROM departments
            WHERE department_id = ?
        `, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Department not found");
        }

        res.redirect("/departments");

    } catch (error) {

        console.error("Error deleting department:", error);

        if (error.code === "ER_ROW_IS_REFERENCED_2" || error.code === "ER_ROW_IS_REFERENCED") {
            return res.status(400).send(
                "Cannot delete this department because it is linked to existing audits or other records."
            );
        }

        res.status(500).send("Error deleting department");
    }
});


module.exports = router;