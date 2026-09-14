const express = require("express");
const router = express.Router();

// Import MySQL database connection/pool
const db = require("../db");


// =====================================================
// 1. READ ALL EMPLOYEES
// GET /employees
// =====================================================
router.get("/", async (req, res) => {

    console.log("🔥 GET /employees HIT");

    try {

        const [employees] = await db.query(`
            SELECT
                e.*,
                d.department_name
            FROM employees e
            LEFT JOIN departments d
                ON e.department_id = d.department_id
            ORDER BY e.employee_id DESC
        `);

        res.render("employees/index", {
            employees: employees,
            title: "Employees"
        }, (err, html) => {
            if (err) {
                console.error("RENDER ERROR:", err);
                return res.status(500).send("Render error: " + err.message);
            }
            res.send(html);
        });

    } catch (error) {

        console.error("Error fetching employees:", error);

        res.status(500).send("Error loading employees");
    }
});


// =====================================================
// 2. SHOW ADD EMPLOYEE FORM
// GET /employees/add
// =====================================================
router.get("/add", async (req, res) => {

    try {

        const [departments] = await db.query(`
            SELECT
                department_id,
                department_name,
                location
            FROM departments
            ORDER BY department_name ASC
        `);

        res.render("employees/add", {
            departments: departments,
            title: "Add Employee"
        });

    } catch (error) {

        console.error("Error loading add employee page:", error);

        res.status(500).send("Error loading add employee page");
    }
});


// =====================================================
// 3. CREATE EMPLOYEE
// POST /employees/add
// =====================================================
router.post("/add", async (req, res) => {

    const {
        employee_name,
        gender,
        phone,
        email,
        job_title,
        department_id,
        employment_date,
        status,
        role_id
    } = req.body;

    if (!employee_name || employee_name.trim() === "") {
        return res.status(400).send("Employee name is required.");
    }

    try {

        await db.query(`
            INSERT INTO employees
                (employee_name, gender, phone, email, job_title,
                 department_id, employment_date, status, role_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            employee_name,
            gender || null,
            phone || null,
            email || null,
            job_title || null,
            department_id || null,
            employment_date || null,
            status || "Active",
            role_id || null
        ]);

        res.redirect("/employees");

    } catch (error) {

        console.error("Error creating employee:", error);

        res.status(500).send(`Error creating employee: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 4. VIEW ONE EMPLOYEE
// GET /employees/view/:id
// =====================================================
router.get("/view/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [employees] = await db.query(`
            SELECT
                e.*,
                d.department_name
            FROM employees e
            LEFT JOIN departments d
                ON e.department_id = d.department_id
            WHERE e.employee_id = ?
        `, [id]);

        if (employees.length === 0) {
            return res.status(404).send("Employee not found");
        }

        res.render("employees/view", {
            employee: employees[0],
            title: "View Employee"
        });

    } catch (error) {

        console.error("Error viewing employee:", error);

        res.status(500).send("Error viewing employee");
    }
});


// =====================================================
// 5. SHOW EDIT EMPLOYEE FORM
// GET /employees/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [employees] = await db.query(`
            SELECT *
            FROM employees
            WHERE employee_id = ?
        `, [id]);

        if (employees.length === 0) {
            return res.status(404).send("Employee not found");
        }

        const [departments] = await db.query(`
            SELECT
                department_id,
                department_name,
                location
            FROM departments
            ORDER BY department_name ASC
        `);

        res.render("employees/edit", {
            employee: employees[0],
            departments: departments,
            title: "Edit Employee"
        });

    } catch (error) {

        console.error("Error loading edit employee page:", error);

        res.status(500).send("Error loading edit employee page");
    }
});


// =====================================================
// 6. UPDATE EMPLOYEE
// POST /employees/edit/:id
// =====================================================
router.post("/edit/:id", async (req, res) => {

    const { id } = req.params;

    const {
        employee_name,
        gender,
        phone,
        email,
        job_title,
        department_id,
        employment_date,
        status,
        role_id
    } = req.body;

    if (!employee_name || employee_name.trim() === "") {
        return res.status(400).send("Employee name is required.");
    }

    try {

        const [result] = await db.query(`
            UPDATE employees
            SET
                employee_name = ?,
                gender = ?,
                phone = ?,
                email = ?,
                job_title = ?,
                department_id = ?,
                employment_date = ?,
                status = ?,
                role_id = ?
            WHERE employee_id = ?
        `, [
            employee_name,
            gender || null,
            phone || null,
            email || null,
            job_title || null,
            department_id || null,
            employment_date || null,
            status || "Active",
            role_id || null,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Employee not found");
        }

        res.redirect("/employees");

    } catch (error) {

        console.error("Error updating employee:", error);

        res.status(500).send(`Error updating employee: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 7. DELETE EMPLOYEE
// POST /employees/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [result] = await db.query(`
            DELETE FROM employees
            WHERE employee_id = ?
        `, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Employee not found");
        }

        res.redirect("/employees");

    } catch (error) {

        console.error("Error deleting employee:", error);

        if (error.code === "ER_ROW_IS_REFERENCED_2" || error.code === "ER_ROW_IS_REFERENCED") {
            return res.status(400).send(
                "Cannot delete this employee because they are linked to other records."
            );
        }

        res.status(500).send("Error deleting employee");
    }
});


module.exports = router;