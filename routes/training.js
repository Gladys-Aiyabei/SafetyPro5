// =====================================================
// TRAINING & COMPLIANCE
// Mounted at /training in app.js (behind guard("training"))
// (the requirements-per-role page stays at /training/gap-analysis)
//
//   /training              training records, endorsed by the line manager with evidence
//   /training/plans        annual training plan + implementation status
//   /training/matrix       staff per role: fully trained or gap
// =====================================================

const express = require("express");
const router = express.Router();

const db = require("../db");
const engine = require("../lib/engine");
const { applyLocation } = require("../lib/registry");
const { isAdmin, roleName, ENFORCE_SEGREGATION } = require("../lib/access");
const { computeCompliance, employeesWithoutRole, planProgress } = require("../lib/compliance");
const { evidenceUpload, evidenceName, handleUpload } = require("../lib/uploads");
const { employeesList, optionalId, optionalText, optionalDate } = require("../lib/lookups");

const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];


// =====================================================
// HELPERS
// =====================================================

// Can this user endorse this training record?
// Line manager of the trained employee (or Admin / a "Line Manager" role when no
// line manager is on file), and never the person who was trained.
function canEndorse(user, row) {

    if (row.endorsed_at) return false;

    const emp = user.employee_id ? Number(user.employee_id) : null;

    if (ENFORCE_SEGREGATION && emp !== null && emp === row.employee_id) return false;

    if (isAdmin(user)) return true;

    if (emp !== null && row.line_manager_id === emp) return true;

    return !row.line_manager_id && roleName(user) === "line manager";
}

function trainingStatus(row) {

    if (!row.endorsed_at) return "Pending Endorsement";

    if (row.expiry_date && new Date(row.expiry_date) < new Date(new Date().toDateString())) {
        return "Expired";
    }

    return "Valid";
}

async function roleOptions() {
    const [roles] = await db.query("SELECT role_id, role_name FROM roles ORDER BY role_name");
    return roles;
}

async function departmentOptions() {
    const [rows] = await db.query("SELECT department_id, department_name FROM departments ORDER BY department_name");
    return rows;
}


// =====================================================
// 1. TRAINING RECORDS  GET /training
// =====================================================
router.get("/", async (req, res) => {

    try {

        const lf = await applyLocation("training", req, res, "t");

        const where = ["1 = 1"];
        const params = [];

        if (req.query.employee_id) {
            where.push("t.employee_id = ?");
            params.push(Number(req.query.employee_id));
        }

        const [rows] = await db.query(`
            SELECT t.*, e.employee_name, e.line_manager_id, r.role_name,
                   lm.employee_name AS line_manager_name,
                   en.username AS endorsed_by_name
            FROM training t
            LEFT JOIN employees e  ON e.employee_id  = t.employee_id
            LEFT JOIN roles r      ON r.role_id      = e.role_id
            LEFT JOIN employees lm ON lm.employee_id = e.line_manager_id
            LEFT JOIN users en     ON en.user_id     = t.endorsed_by
            WHERE ${where.join(" AND ")} ${lf.clause}
            ORDER BY t.training_date DESC, t.training_id DESC
        `, [...params, ...lf.params]);

        const user = req.session.user;

        let records = rows.map(r => ({
            ...r,
            shownStatus: trainingStatus(r),
            canEndorse: canEndorse(user, r)
        }));

        if (req.query.status) {
            records = records.filter(r => r.shownStatus === req.query.status);
        }

        res.render("training/records", {
            title: "Training Records",
            tab: "records",
            records,
            employees: await employeesList(),
            filters: {
                employee_id: req.query.employee_id || "",
                status: req.query.status || ""
            }
        });

    } catch (error) {
        console.error("Error loading training records:", error);
        res.status(500).send("Error loading training records");
    }
});


// =====================================================
// 2. ADD A TRAINING RECORD  GET/POST /training/add
// New records wait for the line manager's endorsement.
// =====================================================
router.get("/add", async (req, res) => {

    try {

        res.render("training/form", {
            title: "Record Training",
            mode: "add",
            error: null,
            values: { employee_id: req.query.employee_id || "", training_name: req.query.training || "" },
            employees: await employeesList()
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading the form");
    }
});

router.post("/add", async (req, res) => {

    const body = req.body || {};

    const v = {
        employee_id: optionalId(body.employee_id),
        training_name: String(body.training_name || "").trim(),
        training_date: optionalDate(body.training_date),
        expiry_date: optionalDate(body.expiry_date),
        trainer: optionalText(body.trainer),
        certificate_number: optionalText(body.certificate_number)
    };

    try {

        if (!v.employee_id || !v.training_name || !v.training_date) {
            return res.status(400).render("training/form", {
                title: "Record Training", mode: "add",
                error: "Employee, training name and training date are required.",
                values: v, employees: await employeesList()
            });
        }

        // No expiry typed? Use the validity of the matching role requirement.
        if (!v.expiry_date) {

            const [req2] = await db.query(`
                SELECT r.validity_months
                FROM employees e
                JOIN role_training_requirements r ON r.role_id = e.role_id
                WHERE e.employee_id = ? AND LOWER(?) LIKE CONCAT('%', LOWER(r.required_training), '%')
                  AND r.validity_months IS NOT NULL
                LIMIT 1
            `, [v.employee_id, v.training_name]);

            if (req2[0]) {
                const d = new Date(v.training_date);
                d.setMonth(d.getMonth() + req2[0].validity_months);
                v.expiry_date = d.toISOString().slice(0, 10);
            }
        }

        await db.query(`
            INSERT INTO training
                (employee_id, training_name, training_date, expiry_date, trainer,
                 certificate_number, status)
            VALUES (?, ?, ?, ?, ?, ?, 'Pending Endorsement')
        `, [
            v.employee_id, v.training_name, v.training_date, v.expiry_date,
            v.trainer, v.certificate_number
        ]);

        res.redirect("/training");

    } catch (error) {
        console.error("Error recording training:", error);
        res.status(500).send(`Error recording training: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 3. ENDORSEMENT BY THE LINE MANAGER, WITH EVIDENCE
// POST /training/endorse/:id   (multipart: evidence file + comments)
// =====================================================
router.post("/endorse/:id",
    handleUpload(evidenceUpload.single("evidence")),
    async (req, res) => {

        try {

            const id = engine.toId(req.params.id);

            const [rows] = await db.query(`
                SELECT t.*, e.line_manager_id
                FROM training t LEFT JOIN employees e ON e.employee_id = t.employee_id
                WHERE t.training_id = ?
            `, [id]);

            if (rows.length === 0) return res.status(404).send("Training record not found");

            const user = req.session.user;

            if (!canEndorse(user, rows[0])) {
                return res.status(403).send(
                    "Only the trained employee's line manager can endorse this training " +
                    "(and not the person who was trained)."
                );
            }

            if (!req.file) {
                return res.status(400).send(
                    "Evidence is required to endorse a training: attach the certificate or attendance record " +
                    "(PDF, image, Word or Excel, up to 10 MB)."
                );
            }

            await db.query(`
                UPDATE training
                SET status = 'Valid', endorsed_by = ?, endorsed_at = NOW(),
                    endorsement_comments = ?, evidence_path = ?
                WHERE training_id = ? AND endorsed_at IS NULL
            `, [
                user.user_id,
                optionalText((req.body || {}).comments),
                evidenceName(req.file),
                id
            ]);

            res.redirect("/training");

        } catch (error) {
            console.error("Error endorsing training:", error);
            res.status(500).send("Error endorsing the training");
        }
    }
);


// =====================================================
// 4. EDIT (Admin)  GET/POST /training/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);

        const [rows] = await db.query("SELECT * FROM training WHERE training_id = ?", [id]);

        if (rows.length === 0) return res.status(404).send("Training record not found");

        res.render("training/form", {
            title: "Edit Training Record",
            mode: "edit",
            error: null,
            values: rows[0],
            recordId: id,
            employees: await employeesList()
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading the form");
    }
});

router.post("/edit/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const body = req.body || {};

        const [result] = await db.query(`
            UPDATE training
            SET employee_id = ?, training_name = ?, training_date = ?, expiry_date = ?,
                trainer = ?, certificate_number = ?
            WHERE training_id = ?
        `, [
            optionalId(body.employee_id),
            String(body.training_name || "").trim(),
            optionalDate(body.training_date),
            optionalDate(body.expiry_date),
            optionalText(body.trainer),
            optionalText(body.certificate_number),
            id
        ]);

        if (result.affectedRows === 0) return res.status(404).send("Training record not found");

        res.redirect("/training");

    } catch (error) {
        console.error("Error updating training:", error);
        res.status(500).send(`Error updating training: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 5. DELETE (Admin)  POST /training/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    try {

        await db.query("DELETE FROM training WHERE training_id = ?", [engine.toId(req.params.id)]);

        res.redirect("/training");

    } catch (error) {
        console.error("Error deleting training:", error);
        res.status(500).send("Error deleting the training record");
    }
});


// =====================================================
// 6. ANNUAL TRAINING PLAN  GET /training/plans?year=
// =====================================================
router.get("/plans", async (req, res) => {

    try {

        const year = Number(req.query.year) || new Date().getFullYear();

        const plans = await planProgress(year);

        res.render("training/plans", {
            title: "Annual Training Plan",
            tab: "plans",
            year,
            plans,
            roles: await roleOptions(),
            months: MONTHS,
            kpi: {
                total: plans.length,
                completed: plans.filter(p => p.implementation === "Completed").length,
                inProgress: plans.filter(p => p.implementation === "In Progress").length,
                overdue: plans.filter(p => p.implementation === "Overdue").length
            }
        });

    } catch (error) {
        console.error("Error loading the training plan:", error);
        res.status(500).send("Error loading the training plan");
    }
});

router.post("/plans/add", async (req, res) => {

    try {

        const body = req.body || {};

        const name = String(body.training_name || "").trim();
        const roleId = optionalId(body.role_id);
        const year = Number(body.plan_year) || new Date().getFullYear();

        if (!name || !roleId) {
            return res.status(400).send("A training plan needs a training name and a role.");
        }

        // One row per month ticked, or the single month chosen.
        const months = [].concat(body.target_month || [])
            .map(Number)
            .filter(m => m >= 1 && m <= 12);

        if (months.length === 0) return res.status(400).send("Choose at least one target month.");

        for (const m of months) {
            await db.query(`
                INSERT INTO annual_training_plans (plan_year, training_name, role_id, target_month, status)
                VALUES (?, ?, ?, ?, 'Planned')
            `, [year, name, roleId, m]);
        }

        res.redirect(`/training/plans?year=${year}`);

    } catch (error) {
        console.error("Error adding plan:", error);
        res.status(500).send(`Error adding the plan: ${error.sqlMessage || error.message}`);
    }
});

// Admin only (URL contains /update)
router.post("/plans/:id/update", async (req, res) => {

    try {

        const body = req.body || {};
        const id = engine.toId(req.params.id);

        await db.query(`
            UPDATE annual_training_plans
            SET training_name = ?, role_id = ?, target_month = ?, status = ?
            WHERE plan_id = ?
        `, [
            String(body.training_name || "").trim(),
            optionalId(body.role_id),
            Number(body.target_month) || 1,
            body.status === "Cancelled" ? "Cancelled" : "Planned",
            id
        ]);

        const [rows] = await db.query("SELECT plan_year FROM annual_training_plans WHERE plan_id = ?", [id]);

        res.redirect(`/training/plans?year=${rows[0] ? rows[0].plan_year : new Date().getFullYear()}`);

    } catch (error) {
        console.error("Error updating plan:", error);
        res.status(500).send("Error updating the plan");
    }
});

// Admin only (URL contains /delete)
router.post("/plans/:id/delete", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);

        const [rows] = await db.query("SELECT plan_year FROM annual_training_plans WHERE plan_id = ?", [id]);

        await db.query("DELETE FROM annual_training_plans WHERE plan_id = ?", [id]);

        res.redirect(`/training/plans?year=${rows[0] ? rows[0].plan_year : new Date().getFullYear()}`);

    } catch (error) {
        console.error("Error deleting plan:", error);
        res.status(500).send("Error deleting the plan");
    }
});


// =====================================================
// 7. COMPLIANCE MATRIX  GET /training/matrix
// =====================================================
router.get("/matrix", async (req, res) => {

    try {

        await applyLocation("training", req, res, "t");   // fills the location dropdown

        const filters = {
            role_id: optionalId(req.query.role_id),
            department_id: optionalId(req.query.department_id),
            location: res.locals.location || null
        };

        const result = await computeCompliance(filters);

        let rows = result.rows;

        if (req.query.result === "gap") rows = rows.filter(r => r.overall === "Gap");
        if (req.query.result === "full") rows = rows.filter(r => r.overall === "Fully trained");

        res.render("training/matrix", {
            title: "Training Compliance",
            tab: "matrix",
            rows,
            summary: result.summary,
            unassigned: await employeesWithoutRole(),
            roles: await roleOptions(),
            departments: await departmentOptions(),
            filters: {
                role_id: req.query.role_id || "",
                department_id: req.query.department_id || "",
                result: req.query.result || ""
            }
        });

    } catch (error) {
        console.error("Error loading compliance matrix:", error);
        res.status(500).send("Error loading the compliance matrix");
    }
});


module.exports = router;
