// =====================================================
// MANAGEMENT OF CHANGE (register of changes per location)
// Mounted at /moc in app.js (behind guard("moc"))
//
//   register: location, change type, approver, status
//   per record: decision by the approver + findings, root causes, actions
// =====================================================

const express = require("express");
const router = express.Router();

const db = require("../db");
const engine = require("../lib/engine");
const { applyLocation, nextMocNumber } = require("../lib/registry");
const { isAdmin, ENFORCE_SEGREGATION } = require("../lib/access");
const { employeesList, knownLocations, optionalId, optionalText, optionalDate } = require("../lib/lookups");

const CHANGE_TYPES = [
    "Process", "Equipment / Plant", "Procedure / Document", "Organisational",
    "Personnel", "Materials / Chemicals", "IT / Systems", "Other"
];
const DURATIONS = ["Permanent", "Temporary", "Emergency"];
const RISK_LEVELS = ["Low", "Medium", "High", "Critical"];
const STATUSES = ["Submitted", "Approved", "Rejected", "Implemented", "Closed"];

// =====================================================
// HELPERS
// =====================================================

async function formData() {
    return {
        employees: await employeesList(),
        locations: await knownLocations(),
        changeTypes: CHANGE_TYPES,
        durations: DURATIONS,
        riskLevels: RISK_LEVELS,
        statuses: STATUSES
    };
}

function readBody(body) {
    return {
        title: String(body.title || "").trim(),
        change_type: String(body.change_type || "").trim(),
        duration_type: DURATIONS.includes(body.duration_type) ? body.duration_type : "Permanent",
        location: optionalText(body.location),
        description: optionalText(body.description),
        reason: optionalText(body.reason),
        risk_level: RISK_LEVELS.includes(body.risk_level) ? body.risk_level : null,
        proposed_by: optionalId(body.proposed_by),
        approver_id: optionalId(body.approver_id),
        request_date: optionalDate(body.request_date),
        planned_date: optionalDate(body.planned_date),
        expiry_date: optionalDate(body.expiry_date),
        status: STATUSES.includes(body.status) ? body.status : "Submitted"
    };
}

async function loadMoc(id) {

    const [rows] = await db.query(`
        SELECT m.*,
               p.employee_name AS proposed_by_name,
               a.employee_name AS approver_name,
               u.username      AS decided_by_name
        FROM moc_records m
        LEFT JOIN employees p ON p.employee_id = m.proposed_by
        LEFT JOIN employees a ON a.employee_id = m.approver_id
        LEFT JOIN users u     ON u.user_id     = m.decided_by
        WHERE m.moc_id = ?
    `, [id]);

    return rows[0] || null;
}


// =====================================================
// 1. REGISTER (list)  GET /moc
// =====================================================
router.get("/", async (req, res) => {

    try {

        const lf = await applyLocation("moc", req, res, "m");

        const where = ["1 = 1"];
        const params = [...lf.params];

        for (const [field, column] of [["status", "m.status"], ["change_type", "m.change_type"], ["duration", "m.duration_type"]]) {
            if (req.query[field]) {
                where.push(`${column} = ?`);
                params.push(req.query[field]);
            }
        }

        const [records] = await db.query(`
            SELECT m.*,
                   p.employee_name AS proposed_by_name,
                   a.employee_name AS approver_name,
                   (SELECT COUNT(*) FROM record_findings f WHERE f.module = 'moc' AND f.record_id = m.moc_id) AS findings,
                   (SELECT COUNT(*) FROM record_actions x WHERE x.module = 'moc' AND x.record_id = m.moc_id AND x.status <> 'Closed') AS open_actions
            FROM moc_records m
            LEFT JOIN employees p ON p.employee_id = m.proposed_by
            LEFT JOIN employees a ON a.employee_id = m.approver_id
            WHERE ${where.join(" AND ")} ${lf.clause}
            ORDER BY m.request_date DESC, m.moc_id DESC
        `, params);

        res.render("moc/index", {
            title: "Management of Change",
            records,
            filters: {
                status: req.query.status || "",
                change_type: req.query.change_type || "",
                duration: req.query.duration || ""
            },
            changeTypes: CHANGE_TYPES,
            statuses: STATUSES,
            durations: DURATIONS
        });

    } catch (error) {
        console.error("Error loading MOC register:", error);
        res.status(500).send("Error loading the MOC register");
    }
});


// =====================================================
// 2. ADD  GET/POST /moc/add
// =====================================================
router.get("/add", async (req, res) => {

    try {

        res.render("moc/form", {
            title: "New Change Request",
            mode: "add",
            error: null,
            values: {
                request_date: new Date().toISOString().slice(0, 10),
                proposed_by: req.session.user.employee_id || "",
                duration_type: "Permanent",
                status: "Submitted"
            },
            ...(await formData())
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading the form");
    }
});

router.post("/add", async (req, res) => {

    const v = readBody(req.body || {});

    // New requests always start as "Submitted"; only an Admin edit changes status.
    v.status = "Submitted";

    try {

        if (!v.title || !v.change_type) {
            return res.status(400).render("moc/form", {
                title: "New Change Request", mode: "add",
                error: "Title and change type are required.",
                values: v, ...(await formData())
            });
        }

        const year = (v.request_date || new Date().toISOString()).slice(0, 4);
        const number = await nextMocNumber(year);

        const [result] = await db.query(`
            INSERT INTO moc_records
                (moc_number, title, change_type, duration_type, location, description, reason,
                 risk_level, proposed_by, approver_id, request_date, planned_date, expiry_date,
                 status, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            number, v.title, v.change_type, v.duration_type, v.location, v.description, v.reason,
            v.risk_level, v.proposed_by, v.approver_id, v.request_date, v.planned_date, v.expiry_date,
            v.status, req.session.user.user_id
        ]);

        res.redirect(`/moc/view/${result.insertId}`);

    } catch (error) {
        console.error("Error creating MOC:", error);
        res.status(500).send(`Error creating the change request: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 3. VIEW  GET /moc/view/:id
// =====================================================
router.get("/view/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const record = id ? await loadMoc(id) : null;

        if (!record) return res.status(404).send("Change request not found");

        const user = req.session.user;

        const isApprover = user.employee_id && Number(user.employee_id) === record.approver_id;
        const isProposer = user.employee_id && Number(user.employee_id) === record.proposed_by;

        // The approver (or an Admin) decides; nobody approves their own request.
        const canDecide = record.status === "Submitted" &&
            (isAdmin(user) || isApprover) &&
            !(ENFORCE_SEGREGATION && isProposer);

        res.render("moc/view", {
            title: `${record.moc_number} - ${record.title}`,
            record,
            canDecide,
            panel: await engine.buildPanel("moc", id, user, `/moc/view/${id}`)
        });

    } catch (error) {
        console.error("Error viewing MOC:", error);
        res.status(500).send("Error viewing the change request");
    }
});


// =====================================================
// 4. APPROVER'S DECISION  POST /moc/decision/:id
// =====================================================
router.post("/decision/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const record = id ? await loadMoc(id) : null;

        if (!record) return res.status(404).send("Change request not found");

        const user = req.session.user;
        const body = req.body || {};

        const isApprover = user.employee_id && Number(user.employee_id) === record.approver_id;
        const isProposer = user.employee_id && Number(user.employee_id) === record.proposed_by;

        if (record.status !== "Submitted" ||
            !(isAdmin(user) || isApprover) ||
            (ENFORCE_SEGREGATION && isProposer)) {
            return res.status(403).send(
                "Only the designated approver (not the person who proposed the change) can decide this request."
            );
        }

        const decision = body.decision === "reject" ? "Rejected" : "Approved";
        const comments = String(body.comments || "").trim();

        if (decision === "Rejected" && !comments) {
            return res.status(400).send("Give a reason when rejecting a change request.");
        }

        await db.query(`
            UPDATE moc_records
            SET status = ?, decided_by = ?, decided_at = NOW(), decision_comments = ?
            WHERE moc_id = ? AND status = 'Submitted'
        `, [decision, user.user_id, comments || null, id]);

        res.redirect(`/moc/view/${id}`);

    } catch (error) {
        console.error("Error saving MOC decision:", error);
        res.status(500).send("Error saving the decision");
    }
});


// =====================================================
// 5. EDIT (Admin)  GET/POST /moc/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const record = id ? await loadMoc(id) : null;

        if (!record) return res.status(404).send("Change request not found");

        res.render("moc/form", {
            title: `Edit ${record.moc_number}`,
            mode: "edit",
            error: null,
            values: record,
            recordId: id,
            ...(await formData())
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading the form");
    }
});

router.post("/edit/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const v = readBody(req.body || {});

        if (!v.title || !v.change_type) {
            return res.status(400).render("moc/form", {
                title: "Edit Change Request", mode: "edit", recordId: id,
                error: "Title and change type are required.",
                values: { ...v, moc_number: "" }, ...(await formData())
            });
        }

        const [result] = await db.query(`
            UPDATE moc_records
            SET title = ?, change_type = ?, duration_type = ?, location = ?, description = ?,
                reason = ?, risk_level = ?, proposed_by = ?, approver_id = ?, request_date = ?,
                planned_date = ?, expiry_date = ?, status = ?
            WHERE moc_id = ?
        `, [
            v.title, v.change_type, v.duration_type, v.location, v.description, v.reason,
            v.risk_level, v.proposed_by, v.approver_id, v.request_date, v.planned_date,
            v.expiry_date, v.status, id
        ]);

        if (result.affectedRows === 0) return res.status(404).send("Change request not found");

        res.redirect(`/moc/view/${id}`);

    } catch (error) {
        console.error("Error updating MOC:", error);
        res.status(500).send(`Error updating: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 6. DELETE (Admin)  POST /moc/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    try {

        await db.query("DELETE FROM moc_records WHERE moc_id = ?", [engine.toId(req.params.id)]);

        res.redirect("/moc");

    } catch (error) {
        console.error("Error deleting MOC:", error);
        res.status(500).send("Error deleting the change request");
    }
});


module.exports = router;
