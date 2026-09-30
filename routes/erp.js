// =====================================================
// EMERGENCY RESPONSE PLANNING (annual drill plan)
// Mounted at /erp in app.js (behind guard("drills"))
//
//   plan drills for the year (single, or repeated across chosen months),
//   record outcomes, and raise findings / root causes / actions per drill
// =====================================================

const express = require("express");
const router = express.Router();

const db = require("../db");
const engine = require("../lib/engine");
const { applyLocation } = require("../lib/registry");
const { employeesList, knownLocations, optionalId, optionalText, optionalDate } = require("../lib/lookups");

const DRILL_TYPES = [
    "Fire", "Evacuation", "Spill / Environmental", "First aid / Medical",
    "Confined space rescue", "Bomb threat / Security", "Natural disaster",
    "Work at height rescue", "Chemical release", "Other"
];
const STATUSES = ["Planned", "Completed", "Postponed", "Cancelled"];
const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];


// =====================================================
// HELPERS
// =====================================================

function pad(n) {
    return String(n).padStart(2, "0");
}

// yyyy-mm-dd for a month/day, clamping the day to the month length
function dateFor(year, month, day) {
    const last = new Date(year, month, 0).getDate();
    return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
}

async function formData() {
    return {
        employees: await employeesList(),
        locations: await knownLocations(),
        drillTypes: DRILL_TYPES,
        statuses: STATUSES,
        months: MONTHS
    };
}

function readBody(body) {

    const plannedDate = optionalDate(body.planned_date);

    return {
        plan_year: Number(body.plan_year) || (plannedDate ? Number(plannedDate.slice(0, 4)) : new Date().getFullYear()),
        drill_type: String(body.drill_type || "").trim(),
        title: String(body.title || "").trim(),
        scenario: optionalText(body.scenario),
        location: optionalText(body.location),
        planned_date: plannedDate,
        actual_date: optionalDate(body.actual_date),
        coordinator_id: optionalId(body.coordinator_id),
        participants: body.participants === "" || body.participants == null ? null : Number(body.participants),
        duration_minutes: body.duration_minutes === "" || body.duration_minutes == null ? null : Number(body.duration_minutes),
        status: STATUSES.includes(body.status) ? body.status : "Planned",
        objectives: optionalText(body.objectives),
        outcome_summary: optionalText(body.outcome_summary)
    };
}

async function loadDrill(id) {

    const [rows] = await db.query(`
        SELECT d.*, e.employee_name AS coordinator_name
        FROM erp_drills d
        LEFT JOIN employees e ON e.employee_id = d.coordinator_id
        WHERE d.drill_id = ?
    `, [id]);

    return rows[0] || null;
}


// =====================================================
// 1. ANNUAL PLAN  GET /erp?year=2026
// =====================================================
router.get("/", async (req, res) => {

    try {

        const year = Number(req.query.year) || new Date().getFullYear();

        const lf = await applyLocation("drills", req, res, "d");

        const where = ["d.plan_year = ?"];
        const params = [year];

        if (req.query.status) {
            where.push("d.status = ?");
            params.push(req.query.status);
        }

        if (req.query.drill_type) {
            where.push("d.drill_type = ?");
            params.push(req.query.drill_type);
        }

        const [drills] = await db.query(`
            SELECT d.*,
                   e.employee_name AS coordinator_name,
                   (d.status = 'Planned' AND d.planned_date < CURDATE()) AS overdue,
                   (SELECT COUNT(*) FROM record_findings f WHERE f.module = 'drills' AND f.record_id = d.drill_id) AS findings,
                   (SELECT COUNT(*) FROM record_actions a WHERE a.module = 'drills' AND a.record_id = d.drill_id AND a.status <> 'Closed') AS open_actions
            FROM erp_drills d
            LEFT JOIN employees e ON e.employee_id = d.coordinator_id
            WHERE ${where.join(" AND ")} ${lf.clause}
            ORDER BY d.planned_date, d.drill_id
        `, [...params, ...lf.params]);

        const [years] = await db.query("SELECT DISTINCT plan_year FROM erp_drills ORDER BY plan_year DESC");

        const yearOptions = new Set(years.map(y => y.plan_year));
        yearOptions.add(year);
        yearOptions.add(new Date().getFullYear());
        yearOptions.add(new Date().getFullYear() + 1);

        const done = drills.filter(d => d.status === "Completed").length;
        const counted = drills.filter(d => d.status !== "Cancelled").length;

        res.render("erp/index", {
            title: "Emergency Response Planning",
            year,
            yearOptions: [...yearOptions].sort((a, b) => b - a),
            drills,
            byMonth: MONTHS.map((name, i) => ({
                name,
                drills: drills.filter(d => new Date(d.planned_date).getMonth() === i)
            })),
            kpi: {
                total: drills.length,
                done,
                overdue: drills.filter(d => d.overdue).length,
                pct: counted ? Math.round((done / counted) * 100) : 0
            },
            filters: { status: req.query.status || "", drill_type: req.query.drill_type || "" },
            drillTypes: DRILL_TYPES,
            statuses: STATUSES
        });

    } catch (error) {
        console.error("Error loading drill plan:", error);
        res.status(500).send("Error loading the drill plan");
    }
});


// =====================================================
// 2. PLAN A DRILL  GET/POST /erp/add
// (tick several months to schedule the same drill through the year)
// =====================================================
router.get("/add", async (req, res) => {

    try {

        const year = Number(req.query.year) || new Date().getFullYear();

        res.render("erp/form", {
            title: "Plan Emergency Drill",
            mode: "add",
            error: null,
            values: { plan_year: year, status: "Planned" },
            ...(await formData())
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading the form");
    }
});

router.post("/add", async (req, res) => {

    const body = req.body || {};
    const v = readBody(body);
    const user = req.session.user;

    // Newly planned drills are always "Planned".
    v.status = "Planned";
    v.actual_date = null;
    v.outcome_summary = null;

    const repeatMonths = [].concat(body.repeat_months || [])
        .map(Number)
        .filter(m => m >= 1 && m <= 12);

    const repeatDay = Math.min(31, Math.max(1, Number(body.repeat_day) || 1));

    try {

        if (!v.drill_type || !v.title) {
            return res.status(400).render("erp/form", {
                title: "Plan Emergency Drill", mode: "add",
                error: "Drill type and title are required.",
                values: v, ...(await formData())
            });
        }

        const dates = repeatMonths.length > 0
            ? repeatMonths.map(m => dateFor(v.plan_year, m, repeatDay))
            : [v.planned_date];

        if (dates.some(d => !d)) {
            return res.status(400).render("erp/form", {
                title: "Plan Emergency Drill", mode: "add",
                error: "Choose a planned date, or tick the months to repeat the drill in.",
                values: v, ...(await formData())
            });
        }

        for (const date of dates) {

            await db.query(`
                INSERT INTO erp_drills
                    (plan_year, drill_type, title, scenario, location, planned_date, coordinator_id,
                     participants, duration_minutes, status, objectives, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Planned', ?, ?)
            `, [
                Number(date.slice(0, 4)), v.drill_type, v.title, v.scenario, v.location, date,
                v.coordinator_id, v.participants, v.duration_minutes, v.objectives, user.user_id
            ]);
        }

        res.redirect(`/erp?year=${dates[0].slice(0, 4)}`);

    } catch (error) {
        console.error("Error planning drill:", error);
        res.status(500).send(`Error planning the drill: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 3. VIEW  GET /erp/view/:id
// =====================================================
router.get("/view/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const drill = id ? await loadDrill(id) : null;

        if (!drill) return res.status(404).send("Drill not found");

        res.render("erp/view", {
            title: drill.title,
            drill,
            panel: await engine.buildPanel("drills", id, req.session.user, `/erp/view/${id}`)
        });

    } catch (error) {
        console.error("Error viewing drill:", error);
        res.status(500).send("Error viewing the drill");
    }
});


// =====================================================
// 4. EDIT (Admin)  GET/POST /erp/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const drill = id ? await loadDrill(id) : null;

        if (!drill) return res.status(404).send("Drill not found");

        res.render("erp/form", {
            title: `Edit Drill: ${drill.title}`,
            mode: "edit",
            error: null,
            values: drill,
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

        const fail = async (message) => res.status(400).render("erp/form", {
            title: "Edit Drill", mode: "edit", recordId: id, error: message,
            values: v, ...(await formData())
        });

        if (!v.drill_type || !v.title || !v.planned_date) {
            return await fail("Drill type, title and planned date are required.");
        }

        // A completed drill needs the date it actually took place.
        if (v.status === "Completed" && !v.actual_date) {
            v.actual_date = v.planned_date;
        }

        const [result] = await db.query(`
            UPDATE erp_drills
            SET plan_year = ?, drill_type = ?, title = ?, scenario = ?, location = ?,
                planned_date = ?, actual_date = ?, coordinator_id = ?, participants = ?,
                duration_minutes = ?, status = ?, objectives = ?, outcome_summary = ?
            WHERE drill_id = ?
        `, [
            v.plan_year, v.drill_type, v.title, v.scenario, v.location, v.planned_date,
            v.actual_date, v.coordinator_id, v.participants, v.duration_minutes, v.status,
            v.objectives, v.outcome_summary, id
        ]);

        if (result.affectedRows === 0) return res.status(404).send("Drill not found");

        res.redirect(`/erp/view/${id}`);

    } catch (error) {
        console.error("Error updating drill:", error);
        res.status(500).send(`Error updating the drill: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 5. DELETE (Admin)  POST /erp/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const drill = id ? await loadDrill(id) : null;

        await db.query("DELETE FROM erp_drills WHERE drill_id = ?", [id]);

        res.redirect(`/erp?year=${drill ? drill.plan_year : new Date().getFullYear()}`);

    } catch (error) {
        console.error("Error deleting drill:", error);
        res.status(500).send("Error deleting the drill");
    }
});


module.exports = router;
