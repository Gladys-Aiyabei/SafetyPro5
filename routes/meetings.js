// =====================================================
// MEETING MANAGER
// Mounted at /meetings in app.js (behind guard("meetings"))
//
//   a meeting record + attendance + minutes + actions (and findings)
// =====================================================

const express = require("express");
const router = express.Router();

const db = require("../db");
const engine = require("../lib/engine");
const { applyLocation } = require("../lib/registry");
const { employeesList, knownLocations, optionalId, optionalText, optionalDate } = require("../lib/lookups");

const MEETING_TYPES = [
    "Toolbox talk", "HSSEQ committee", "Management review", "Safety induction",
    "Contractor meeting", "Incident review", "Emergency planning", "Other"
];
const STATUSES = ["Scheduled", "Held", "Cancelled"];
const ATTENDANCE = ["Present", "Absent", "Apologies"];


// =====================================================
// HELPERS
// =====================================================

async function formData() {
    return {
        employees: await employeesList(),
        locations: await knownLocations(),
        meetingTypes: MEETING_TYPES,
        statuses: STATUSES
    };
}

function readBody(body) {

    const time = String(body.start_time || "").trim();

    return {
        title: String(body.title || "").trim(),
        meeting_type: String(body.meeting_type || "").trim(),
        meeting_date: optionalDate(body.meeting_date),
        start_time: /^\d{2}:\d{2}$/.test(time) ? time : null,
        location: optionalText(body.location),
        chairperson_id: optionalId(body.chairperson_id),
        agenda: optionalText(body.agenda),
        status: STATUSES.includes(body.status) ? body.status : "Scheduled"
    };
}

async function loadMeeting(id) {

    const [rows] = await db.query(`
        SELECT m.*, e.employee_name AS chairperson_name
        FROM meetings m
        LEFT JOIN employees e ON e.employee_id = m.chairperson_id
        WHERE m.meeting_id = ?
    `, [id]);

    return rows[0] || null;
}


// =====================================================
// 1. LIST  GET /meetings
// =====================================================
router.get("/", async (req, res) => {

    try {

        const lf = await applyLocation("meetings", req, res, "m");

        const where = ["1 = 1"];
        const params = [];

        if (req.query.meeting_type) {
            where.push("m.meeting_type = ?");
            params.push(req.query.meeting_type);
        }

        if (req.query.status) {
            where.push("m.status = ?");
            params.push(req.query.status);
        }

        if (req.query.year) {
            where.push("YEAR(m.meeting_date) = ?");
            params.push(Number(req.query.year));
        }

        const [meetings] = await db.query(`
            SELECT m.*,
                   e.employee_name AS chairperson_name,
                   (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id = m.meeting_id AND a.attendance = 'Present') AS present,
                   (SELECT COUNT(*) FROM meeting_minutes n WHERE n.meeting_id = m.meeting_id) AS minutes,
                   (SELECT COUNT(*) FROM record_actions x WHERE x.module = 'meetings' AND x.record_id = m.meeting_id AND x.status <> 'Closed') AS open_actions
            FROM meetings m
            LEFT JOIN employees e ON e.employee_id = m.chairperson_id
            WHERE ${where.join(" AND ")} ${lf.clause}
            ORDER BY m.meeting_date DESC, m.meeting_id DESC
        `, [...params, ...lf.params]);

        res.render("meetings/index", {
            title: "Meeting Manager",
            meetings,
            meetingTypes: MEETING_TYPES,
            statuses: STATUSES,
            filters: {
                meeting_type: req.query.meeting_type || "",
                status: req.query.status || "",
                year: req.query.year || ""
            }
        });

    } catch (error) {
        console.error("Error loading meetings:", error);
        res.status(500).send("Error loading meetings");
    }
});


// =====================================================
// 2. ADD  GET/POST /meetings/add
// =====================================================
router.get("/add", async (req, res) => {

    try {

        res.render("meetings/form", {
            title: "New Meeting",
            mode: "add",
            error: null,
            values: {
                meeting_date: new Date().toISOString().slice(0, 10),
                chairperson_id: req.session.user.employee_id || "",
                status: "Scheduled"
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

    try {

        if (!v.title || !v.meeting_type || !v.meeting_date) {
            return res.status(400).render("meetings/form", {
                title: "New Meeting", mode: "add",
                error: "Title, meeting type and date are required.",
                values: v, ...(await formData())
            });
        }

        const [result] = await db.query(`
            INSERT INTO meetings
                (title, meeting_type, meeting_date, start_time, location, chairperson_id,
                 agenda, status, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            v.title, v.meeting_type, v.meeting_date, v.start_time, v.location,
            v.chairperson_id, v.agenda, v.status, req.session.user.user_id
        ]);

        res.redirect(`/meetings/view/${result.insertId}`);

    } catch (error) {
        console.error("Error creating meeting:", error);
        res.status(500).send(`Error creating the meeting: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 3. VIEW (attendance, minutes, actions)  GET /meetings/view/:id
// =====================================================
router.get("/view/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const meeting = id ? await loadMeeting(id) : null;

        if (!meeting) return res.status(404).send("Meeting not found");

        const [attendees] = await db.query(`
            SELECT * FROM meeting_attendees
            WHERE meeting_id = ?
            ORDER BY attendee_name
        `, [id]);

        const [minutes] = await db.query(`
            SELECT * FROM meeting_minutes
            WHERE meeting_id = ?
            ORDER BY item_no, minute_id
        `, [id]);

        res.render("meetings/view", {
            title: meeting.title,
            meeting,
            attendees,
            minutes,
            employees: await employeesList(),
            attendanceOptions: ATTENDANCE,
            panel: await engine.buildPanel("meetings", id, req.session.user, `/meetings/view/${id}`)
        });

    } catch (error) {
        console.error("Error viewing meeting:", error);
        res.status(500).send("Error viewing the meeting");
    }
});


// =====================================================
// 4. ATTENDANCE  POST /meetings/:id/attendees
// Pick one or more employees, and/or type the name of an outside attendee.
// =====================================================
router.post("/:id/attendees", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const meeting = id ? await loadMeeting(id) : null;

        if (!meeting) return res.status(404).send("Meeting not found");

        const body = req.body || {};
        const attendance = ATTENDANCE.includes(body.attendance) ? body.attendance : "Present";

        const employeeIds = [].concat(body.employee_ids || [])
            .map(Number)
            .filter(n => Number.isInteger(n) && n > 0);

        const external = String(body.external_name || "").trim();

        if (employeeIds.length === 0 && !external) {
            return res.status(400).send("Select at least one employee or enter an attendee name.");
        }

        if (employeeIds.length > 0) {

            const [emps] = await db.query(
                "SELECT employee_id, employee_name FROM employees WHERE employee_id IN (?)",
                [employeeIds]
            );

            for (const e of emps) {
                // Already listed? Keep one row per employee per meeting.
                await db.query(`
                    INSERT INTO meeting_attendees (meeting_id, employee_id, attendee_name, attendance)
                    VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE attendance = VALUES(attendance)
                `, [id, e.employee_id, e.employee_name, attendance]);
            }
        }

        if (external) {
            await db.query(`
                INSERT INTO meeting_attendees (meeting_id, employee_id, attendee_name, attendance)
                VALUES (?, NULL, ?, ?)
            `, [id, external.slice(0, 120), attendance]);
        }

        res.redirect(`/meetings/view/${id}#attendance`);

    } catch (error) {
        console.error("Error saving attendance:", error);
        res.status(500).send("Error saving attendance");
    }
});

// Admin only (the guard blocks non-admins: URL contains /delete)
router.post("/attendees/:aid/delete", async (req, res) => {

    try {

        const aid = engine.toId(req.params.aid);

        const [rows] = await db.query(
            "SELECT meeting_id FROM meeting_attendees WHERE attendee_id = ?", [aid]
        );

        await db.query("DELETE FROM meeting_attendees WHERE attendee_id = ?", [aid]);

        res.redirect(`/meetings/view/${rows[0] ? rows[0].meeting_id : ""}#attendance`);

    } catch (error) {
        console.error("Error removing attendee:", error);
        res.status(500).send("Error removing the attendee");
    }
});


// =====================================================
// 5. MINUTES  POST /meetings/:id/minutes
// =====================================================
router.post("/:id/minutes", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const meeting = id ? await loadMeeting(id) : null;

        if (!meeting) return res.status(404).send("Meeting not found");

        const body = req.body || {};
        const topic = String(body.topic || "").trim();

        if (!topic) return res.status(400).send("Each minute item needs a topic.");

        const [max] = await db.query(
            "SELECT COALESCE(MAX(item_no), 0) AS n FROM meeting_minutes WHERE meeting_id = ?", [id]
        );

        await db.query(`
            INSERT INTO meeting_minutes (meeting_id, item_no, topic, discussion, decision, created_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            id, max[0].n + 1, topic.slice(0, 200),
            optionalText(body.discussion), optionalText(body.decision),
            req.session.user.user_id
        ]);

        // Minutes being written means the meeting took place.
        await db.query(
            "UPDATE meetings SET status = 'Held' WHERE meeting_id = ? AND status = 'Scheduled'", [id]
        );

        res.redirect(`/meetings/view/${id}#minutes`);

    } catch (error) {
        console.error("Error saving minutes:", error);
        res.status(500).send("Error saving the minutes");
    }
});

// Admin only (the guard blocks non-admins: URL contains /delete)
router.post("/minutes/:mid/delete", async (req, res) => {

    try {

        const mid = engine.toId(req.params.mid);

        const [rows] = await db.query(
            "SELECT meeting_id FROM meeting_minutes WHERE minute_id = ?", [mid]
        );

        await db.query("DELETE FROM meeting_minutes WHERE minute_id = ?", [mid]);

        res.redirect(`/meetings/view/${rows[0] ? rows[0].meeting_id : ""}#minutes`);

    } catch (error) {
        console.error("Error removing minute:", error);
        res.status(500).send("Error removing the minute");
    }
});


// =====================================================
// 6. EDIT (Admin)  GET/POST /meetings/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    try {

        const id = engine.toId(req.params.id);
        const meeting = id ? await loadMeeting(id) : null;

        if (!meeting) return res.status(404).send("Meeting not found");

        res.render("meetings/form", {
            title: `Edit Meeting: ${meeting.title}`,
            mode: "edit",
            error: null,
            values: { ...meeting, start_time: meeting.start_time ? String(meeting.start_time).slice(0, 5) : "" },
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

        if (!v.title || !v.meeting_type || !v.meeting_date) {
            return res.status(400).render("meetings/form", {
                title: "Edit Meeting", mode: "edit", recordId: id,
                error: "Title, meeting type and date are required.",
                values: v, ...(await formData())
            });
        }

        const [result] = await db.query(`
            UPDATE meetings
            SET title = ?, meeting_type = ?, meeting_date = ?, start_time = ?, location = ?,
                chairperson_id = ?, agenda = ?, status = ?
            WHERE meeting_id = ?
        `, [
            v.title, v.meeting_type, v.meeting_date, v.start_time, v.location,
            v.chairperson_id, v.agenda, v.status, id
        ]);

        if (result.affectedRows === 0) return res.status(404).send("Meeting not found");

        res.redirect(`/meetings/view/${id}`);

    } catch (error) {
        console.error("Error updating meeting:", error);
        res.status(500).send(`Error updating the meeting: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 7. DELETE (Admin)  POST /meetings/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    try {

        await db.query("DELETE FROM meetings WHERE meeting_id = ?", [engine.toId(req.params.id)]);

        res.redirect("/meetings");

    } catch (error) {
        console.error("Error deleting meeting:", error);
        res.status(500).send("Error deleting the meeting");
    }
});


module.exports = router;
