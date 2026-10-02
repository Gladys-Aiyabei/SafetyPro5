// =====================================================
// INCIDENT INVESTIGATION & SIGN-OFF
// Used by routes/incidents.js (mounted under /incidents)
//
//   Line manager of the incident (incidents.line_manager_id) may add / change / remove:
//     classification, learnings, rating, injuries, findings, actions, witnesses, pictures
//   Head of Safety (employee role, from employee details) signs the incident off,
//     which closes it and locks the investigation.
//
//   POST /incidents/:id/inv/report                  classification + learnings + rating
//   POST /incidents/:id/inv/injury                  (+ /:jid/save, /:jid/remove)
//   POST /incidents/:id/inv/finding                 (+ /:fid/save, /:fid/remove)
//   POST /incidents/:id/inv/action                  (+ /:aid/save, /:aid/remove)
//   POST /incidents/:id/inv/witness                 (+ /:wid/save, /:wid/remove)
//   POST /incidents/:id/inv/photo                   (+ /:pid/remove)
//   POST /incidents/:id/signoff                     closes it + emails the learning alert to all users
//   GET  /incidents/:id/learning-alert              learning alert PDF
//   GET  /incidents/photo/:file
//
// Route names avoid "add" / "edit" / "delete" on purpose: lib/access.js guard() reserves
// those for its own role rules, and these routes do their own line-manager check.
// =====================================================

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = express.Router();

const db = require("../db");
const { deny } = require("../lib/access");
const { LIKELIHOOD, CONSEQUENCE, rating } = require("../lib/incidentRating");
const learningAlert = require("../lib/learningAlert");


// =====================================================
// SETTINGS
// =====================================================

const CLASSIFICATIONS = [
    "Lost Time Injury",
    "Light Motor Vehicle Incident",
    "Rollover",
    "Spill",
    "Fatality"
];

const ACTION_STATUSES = ["Open", "In Progress", "Completed"];

const TREATMENTS = ["First Aid", "Medical Treatment", "Restricted Work", "Lost Time", "Fatality"];


// Employee role (roles.role_name) allowed to sign incidents off.
const SIGN_OFF_ROLE = "head of safety";


// =====================================================
// PICTURES (stored outside /public, served to logged-in users only)
// =====================================================

const PHOTO_DIR = path.join(__dirname, "..", "uploads", "incidents");

fs.mkdirSync(PHOTO_DIR, { recursive: true });

const PHOTO_TYPES = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

const photoUpload = multer({
    storage: multer.diskStorage({
        destination: PHOTO_DIR,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        cb(null, PHOTO_TYPES.includes(path.extname(file.originalname).toLowerCase()));
    }
});


// =====================================================
// HELPERS
// =====================================================

const toId = v => (/^\d+$/.test(String(v)) ? Number(v) : null);
const text = v => (typeof v === "string" && v.trim() ? v.trim() : null);

async function loadIncident(id) {
    const [rows] = await db.query("SELECT * FROM incidents WHERE incident_id = ?", [id]);
    return rows[0] || null;
}

function isLineManager(user, incident) {
    return Boolean(
        user && user.employee_id && incident.line_manager_id &&
        Number(user.employee_id) === Number(incident.line_manager_id)
    );
}

async function isHeadOfSafety(user) {

    if (!user || !user.employee_id) return false;

    const [rows] = await db.query(`
        SELECT 1
        FROM employees e
        JOIN roles r ON r.role_id = e.role_id
        WHERE e.employee_id = ?
          AND LOWER(TRIM(r.role_name)) = ?
    `, [user.employee_id, SIGN_OFF_ROLE]);

    return rows.length > 0;
}

const backTo = id => `/incidents/view/${id}#investigation`;

// Wraps the line-manager investigation routes: loads the incident, checks the user
// is its line manager and that it has not been signed off yet.
function asLineManager(handler) {
    return async (req, res) => {
        try {
            const id = toId(req.params.id);
            const incident = id && await loadIncident(id);

            if (!incident) return res.status(404).send("Incident not found");

            if (!isLineManager(req.session.user, incident)) {
                return deny(res, "Only the line manager assigned to this incident can change its investigation.");
            }

            if (incident.signed_off_at) {
                return deny(res, "This incident has been signed off by the Head of Safety and is closed.");
            }

            await handler(req, res, incident);

            if (!res.headersSent) res.redirect(backTo(id));

        } catch (error) {
            console.error("Incident investigation error:", error);
            if (!res.headersSent) {
                res.status(500).send(`Error saving investigation: ${error.sqlMessage || error.message}`);
            }
        }
    };
}

function bad(res, message) {
    res.status(400).send(message);
}


// =====================================================
// DATA FOR THE VIEW PAGE
// =====================================================

async function investigationFor(incident, user) {

    const id = incident.incident_id;

    const [[injuries], [findings], [actions], [witnesses], [photos], [employees], headOfSafety] = await Promise.all([
        db.query("SELECT * FROM incident_injuries WHERE incident_id = ? ORDER BY injury_id", [id]),
        db.query("SELECT * FROM incident_findings WHERE incident_id = ? ORDER BY finding_id", [id]),
        db.query(`
            SELECT a.*, e.employee_name AS responsible_name
            FROM incident_actions a
            LEFT JOIN employees e ON e.employee_id = a.responsible_id
            WHERE a.incident_id = ?
            ORDER BY a.action_id`, [id]),
        db.query("SELECT * FROM incident_witnesses WHERE incident_id = ? ORDER BY witness_id", [id]),
        db.query("SELECT * FROM incident_images WHERE incident_id = ? ORDER BY image_id", [id]),
        db.query("SELECT employee_id, employee_name FROM employees ORDER BY employee_name"),
        isHeadOfSafety(user)
    ]);

    const signedOff = Boolean(incident.signed_off_at);

    return {
        injuries,
        findings,
        actions,
        witnesses,
        photos,
        employees,
        classifications: CLASSIFICATIONS,
        actionStatuses: ACTION_STATUSES,
        treatments: TREATMENTS,
        likelihoodScale: LIKELIHOOD,
        consequenceScale: CONSEQUENCE,
        rating: rating(incident),
        signedOff,
        canInvestigate: isLineManager(user, incident) && !signedOff,
        canSignOff: headOfSafety && !signedOff
    };
}


// =====================================================
// PICTURE FILES
// GET /incidents/photo/:file
// =====================================================

router.get("/photo/:file", (req, res) => {
    res.sendFile(path.join(PHOTO_DIR, path.basename(req.params.file)), err => {
        if (err && !res.headersSent) res.status(404).send("File not found");
    });
});


// =====================================================
// REPORT DETAILS: CLASSIFICATION, LEARNINGS, RATING
// =====================================================

const scale = v => (/^[1-5]$/.test(String(v)) ? Number(v) : null);

router.post("/:id/inv/report", asLineManager(async (req, res, incident) => {

    // Each form on the page sends only its own fields; only those are updated.
    const body = req.body;
    const sets = {};

    if ("classification" in body) {
        const value = text(body.classification);
        if (value && !CLASSIFICATIONS.includes(value)) return bad(res, "Unknown classification.");
        sets.classification = value;
    }
    if ("learnings" in body) sets.learnings = text(body.learnings);
    if ("likelihood" in body) sets.likelihood = scale(body.likelihood);
    if ("consequence" in body) sets.consequence = scale(body.consequence);

    const keys = Object.keys(sets);

    if (keys.length === 0) return;

    await db.query(
        `UPDATE incidents SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE incident_id = ?`,
        [...keys.map(k => sets[k]), incident.incident_id]
    );
}));


// =====================================================
// INJURIES
// =====================================================

function injuryValues(body) {
    const days = /^\d+$/.test(String(body.days_lost || "").trim()) ? Number(body.days_lost) : null;
    return [
        text(body.injured_person),
        text(body.injury_type),
        text(body.body_part),
        TREATMENTS.includes(body.treatment) ? body.treatment : null,
        days
    ];
}

router.post("/:id/inv/injury", asLineManager(async (req, res, incident) => {

    const v = injuryValues(req.body);

    if (!v[0]) return bad(res, "Injured person is required.");

    await db.query(`
        INSERT INTO incident_injuries (incident_id, injured_person, injury_type, body_part, treatment, days_lost)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [incident.incident_id, ...v]);
}));

router.post("/:id/inv/injury/:jid/save", asLineManager(async (req, res, incident) => {

    const v = injuryValues(req.body);

    if (!v[0]) return bad(res, "Injured person is required.");

    await db.query(`
        UPDATE incident_injuries
        SET injured_person = ?, injury_type = ?, body_part = ?, treatment = ?, days_lost = ?
        WHERE injury_id = ? AND incident_id = ?
    `, [...v, toId(req.params.jid), incident.incident_id]);
}));

router.post("/:id/inv/injury/:jid/remove", asLineManager(async (req, res, incident) => {
    await db.query(
        "DELETE FROM incident_injuries WHERE injury_id = ? AND incident_id = ?",
        [toId(req.params.jid), incident.incident_id]
    );
}));


// =====================================================
// FINDINGS
// =====================================================

router.post("/:id/inv/finding", asLineManager(async (req, res, incident) => {

    const finding = text(req.body.finding_text);

    if (!finding) return bad(res, "Finding text is required.");

    await db.query(
        "INSERT INTO incident_findings (incident_id, finding_text) VALUES (?, ?)",
        [incident.incident_id, finding]
    );
}));

router.post("/:id/inv/finding/:fid/save", asLineManager(async (req, res, incident) => {

    const finding = text(req.body.finding_text);

    if (!finding) return bad(res, "Finding text is required.");

    await db.query(
        "UPDATE incident_findings SET finding_text = ? WHERE finding_id = ? AND incident_id = ?",
        [finding, toId(req.params.fid), incident.incident_id]
    );
}));

router.post("/:id/inv/finding/:fid/remove", asLineManager(async (req, res, incident) => {
    await db.query(
        "DELETE FROM incident_findings WHERE finding_id = ? AND incident_id = ?",
        [toId(req.params.fid), incident.incident_id]
    );
}));


// =====================================================
// ACTIONS
// =====================================================

function actionValues(body) {
    return {
        action_text: text(body.action_text),
        responsible_id: toId(body.responsible_id),
        due_date: text(body.due_date),
        status: ACTION_STATUSES.includes(body.status) ? body.status : "Open"
    };
}

router.post("/:id/inv/action", asLineManager(async (req, res, incident) => {

    const a = actionValues(req.body);

    if (!a.action_text) return bad(res, "Action description is required.");

    await db.query(`
        INSERT INTO incident_actions (incident_id, action_text, responsible_id, due_date, status)
        VALUES (?, ?, ?, ?, ?)
    `, [incident.incident_id, a.action_text, a.responsible_id, a.due_date, a.status]);
}));

router.post("/:id/inv/action/:aid/save", asLineManager(async (req, res, incident) => {

    const a = actionValues(req.body);

    if (!a.action_text) return bad(res, "Action description is required.");

    await db.query(`
        UPDATE incident_actions
        SET action_text = ?, responsible_id = ?, due_date = ?, status = ?
        WHERE action_id = ? AND incident_id = ?
    `, [a.action_text, a.responsible_id, a.due_date, a.status, toId(req.params.aid), incident.incident_id]);
}));

router.post("/:id/inv/action/:aid/remove", asLineManager(async (req, res, incident) => {
    await db.query(
        "DELETE FROM incident_actions WHERE action_id = ? AND incident_id = ?",
        [toId(req.params.aid), incident.incident_id]
    );
}));


// =====================================================
// WITNESSES
// =====================================================

router.post("/:id/inv/witness", asLineManager(async (req, res, incident) => {

    const name = text(req.body.witness_name);

    if (!name) return bad(res, "Witness name is required.");

    await db.query(`
        INSERT INTO incident_witnesses (incident_id, witness_name, contact, statement)
        VALUES (?, ?, ?, ?)
    `, [incident.incident_id, name, text(req.body.contact), text(req.body.statement)]);
}));

router.post("/:id/inv/witness/:wid/save", asLineManager(async (req, res, incident) => {

    const name = text(req.body.witness_name);

    if (!name) return bad(res, "Witness name is required.");

    await db.query(`
        UPDATE incident_witnesses
        SET witness_name = ?, contact = ?, statement = ?
        WHERE witness_id = ? AND incident_id = ?
    `, [name, text(req.body.contact), text(req.body.statement), toId(req.params.wid), incident.incident_id]);
}));

router.post("/:id/inv/witness/:wid/remove", asLineManager(async (req, res, incident) => {
    await db.query(
        "DELETE FROM incident_witnesses WHERE witness_id = ? AND incident_id = ?",
        [toId(req.params.wid), incident.incident_id]
    );
}));


// =====================================================
// PICTURES
// =====================================================

function receivePhotos(req, res, next) {
    photoUpload.array("photos", 10)(req, res, err => {
        if (!err) return next();
        res.status(400).send(
            `Upload failed: ${err.code === "LIMIT_FILE_SIZE" ? "a picture is larger than 10 MB" : err.message}`
        );
    });
}

function discard(files) {
    (files || []).forEach(f => fs.unlink(f.path, () => {}));
}

router.post("/:id/inv/photo", receivePhotos, (req, res, next) => {
    // Files are already on disk; drop them again if the user may not add them.
    res.on("finish", () => { if (res.statusCode !== 302) discard(req.files); });
    next();
}, asLineManager(async (req, res, incident) => {

    if (!req.files || req.files.length === 0) {
        return bad(res, "Choose at least one picture (jpg, png, gif or webp).");
    }

    const caption = text(req.body.caption);

    await db.query(
        "INSERT INTO incident_images (incident_id, file_path, original_name, caption) VALUES ?",
        [req.files.map(f => [incident.incident_id, f.filename, f.originalname, caption])]
    );
}));

router.post("/:id/inv/photo/:pid/remove", asLineManager(async (req, res, incident) => {

    const [rows] = await db.query(
        "SELECT file_path FROM incident_images WHERE image_id = ? AND incident_id = ?",
        [toId(req.params.pid), incident.incident_id]
    );

    if (rows.length === 0) return;

    await db.query("DELETE FROM incident_images WHERE image_id = ?", [toId(req.params.pid)]);

    fs.unlink(path.join(PHOTO_DIR, path.basename(rows[0].file_path)), () => {});
}));


// =====================================================
// HEAD OF SAFETY SIGN-OFF (closes the incident)
// =====================================================

router.post("/:id/signoff", async (req, res) => {

    try {
        const id = toId(req.params.id);
        const incident = id && await loadIncident(id);
        const user = req.session.user;

        if (!incident) return res.status(404).send("Incident not found");

        if (!(await isHeadOfSafety(user))) {
            return deny(res, "Only an employee with the Head of Safety role can sign incidents off.");
        }

        if (incident.signed_off_at) return res.redirect(backTo(id));

        if (!incident.classification) {
            return bad(res, "The line manager must classify the incident before it can be signed off.");
        }

        const [result] = await db.query(`
            UPDATE incidents
            SET signed_off_by = ?,
                signed_off_at = NOW(),
                signoff_comments = ?,
                status = 'Closed'
            WHERE incident_id = ? AND signed_off_at IS NULL
        `, [user.employee_id, text(req.body.signoff_comments), id]);

        // Closed now: build the learning alert PDF and email it to all users (in the background).
        if (result.affectedRows === 1) learningAlert.distributeLearningAlert(id);

        res.redirect(backTo(id));

    } catch (error) {
        console.error("Incident sign-off error:", error);
        res.status(500).send(`Error signing off incident: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// LEARNING ALERT PDF (signed-off incidents)
// GET /incidents/:id/learning-alert
// =====================================================

router.get("/:id/learning-alert", async (req, res) => {

    try {
        const id = toId(req.params.id);
        const incident = id && await loadIncident(id);

        if (!incident) return res.status(404).send("Incident not found");

        if (!incident.signed_off_at) {
            return res.status(400).send("The learning alert is available once the Head of Safety has signed the incident off.");
        }

        const alert = await learningAlert.buildLearningAlert(id);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${alert.filename}"`);
        res.send(alert.buffer);

    } catch (error) {
        console.error("Learning alert error:", error);
        res.status(500).send(`Error building learning alert: ${error.message}`);
    }
});


router.investigationFor = investigationFor;
router.CLASSIFICATIONS = CLASSIFICATIONS;

module.exports = router;
