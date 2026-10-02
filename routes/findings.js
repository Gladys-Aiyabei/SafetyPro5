// =====================================================
// FINDINGS, ROOT CAUSES & ACTIONS (all modules)
// Mounted at /findings in app.js
//
//   GET  /findings/:module/:id         page for one record: findings + checklist
//   POST /findings/:module/:id/...     add finding / general action / checklist answers
//   POST /findings/f/:fid/...          root causes, actions, edit/delete of a finding
//   POST /findings/a/:aid/...          action workflow: start / submit / approve / reject
// =====================================================

const express = require("express");
const path = require("path");
const router = express.Router();

const db = require("../db");
const engine = require("../lib/engine");
const { roleCan, isAdmin, deny } = require("../lib/access");
const { MODULES, FINDING_MODULES } = require("../lib/registry");
const { evidenceUpload, evidenceName, handleUpload, EVIDENCE_DIR } = require("../lib/uploads");
const { safeReturn } = require("../lib/format");

const { EngineError, toId, clean } = engine;


// =====================================================
// HELPERS
// =====================================================

function recordUrl(moduleKey, recordId) {
    return `/findings/${moduleKey}/${recordId}`;
}

// Runs a handler, sends expected errors as readable messages.
function run(handler) {
    return async (req, res, next) => {
        try {
            await handler(req, res, next);
        } catch (error) {
            if (error instanceof EngineError) {
                return res.status(error.status).send(error.message);
            }
            console.error("Findings error:", error);
            res.status(500).send(`Error: ${error.sqlMessage || error.message}`);
        }
    };
}

function requireAdminHere(req, res) {
    if (isAdmin(req.session.user)) return true;
    deny(res, "Only an Admin can edit or delete findings, root causes and actions.");
    return false;
}

// For finding-level routes: which module/record does this finding belong to?
async function loadFinding(findingId) {

    const [rows] = await db.query(
        "SELECT * FROM record_findings WHERE finding_id = ?", [findingId]
    );

    if (rows.length === 0) throw new EngineError("Finding not found.", 404);

    return rows[0];
}

function backTo(req, moduleKey, recordId) {
    return safeReturn((req.body || {}).return_to, recordUrl(moduleKey, recordId));
}


// =====================================================
// EVIDENCE FILES (logged-in users only)
// GET /findings/evidence/:file
// =====================================================
router.get("/evidence/:file", (req, res) => {

    const file = path.basename(req.params.file);

    res.sendFile(path.join(EVIDENCE_DIR, file), (err) => {
        if (err) res.status(404).send("File not found");
    });
});


// =====================================================
// ACTION WORKFLOW
// =====================================================

router.post("/a/:aid/start", run(async (req, res) => {

    const id = toId(req.params.aid);

    await engine.startAction(id, req.session.user);

    const [rows] = await db.query(
        "SELECT module, record_id FROM record_actions WHERE action_id = ?", [id]
    );

    res.redirect(backTo(req, rows[0].module, rows[0].record_id));
}));

router.post("/a/:aid/submit",
    handleUpload(evidenceUpload.single("evidence")),
    run(async (req, res) => {

        const id = toId(req.params.aid);

        await engine.submitAction(id, req.session.user, req.body || {}, evidenceName(req.file));

        const [rows] = await db.query(
            "SELECT module, record_id FROM record_actions WHERE action_id = ?", [id]
        );

        res.redirect(backTo(req, rows[0].module, rows[0].record_id));
    })
);

router.post("/a/:aid/approve", run(async (req, res) => {

    const id = toId(req.params.aid);

    await engine.approveAction(id, req.session.user, req.body || {});

    const [rows] = await db.query(
        "SELECT module, record_id FROM record_actions WHERE action_id = ?", [id]
    );

    res.redirect(backTo(req, rows[0].module, rows[0].record_id));
}));

router.post("/a/:aid/reject", run(async (req, res) => {

    const id = toId(req.params.aid);

    await engine.rejectAction(id, req.session.user, req.body || {});

    const [rows] = await db.query(
        "SELECT module, record_id FROM record_actions WHERE action_id = ?", [id]
    );

    res.redirect(backTo(req, rows[0].module, rows[0].record_id));
}));

// Admin only
router.post("/a/:aid/edit", run(async (req, res) => {

    if (!requireAdminHere(req, res)) return;

    const id = toId(req.params.aid);

    await engine.updateAction(id, req.body || {});

    const [rows] = await db.query(
        "SELECT module, record_id FROM record_actions WHERE action_id = ?", [id]
    );

    res.redirect(backTo(req, rows[0].module, rows[0].record_id));
}));

// Admin only
router.post("/a/:aid/delete", run(async (req, res) => {

    if (!requireAdminHere(req, res)) return;

    const id = toId(req.params.aid);

    const [rows] = await db.query(
        "SELECT module, record_id FROM record_actions WHERE action_id = ?", [id]
    );

    if (rows.length === 0) throw new EngineError("Action not found.", 404);

    await engine.deleteAction(id);

    res.redirect(backTo(req, rows[0].module, rows[0].record_id));
}));


// =====================================================
// FINDING-LEVEL: root causes and actions
// =====================================================

router.post("/f/:fid/root-causes", run(async (req, res) => {

    const finding = await loadFinding(toId(req.params.fid));

    if (!roleCan(req.session.user, finding.module, "add")) {
        return deny(res, "You cannot add root causes to this module's records.");
    }

    await engine.addRootCause(finding.finding_id, req.session.user, req.body || {});

    res.redirect(backTo(req, finding.module, finding.record_id));
}));

router.post("/f/:fid/actions", run(async (req, res) => {

    const finding = await loadFinding(toId(req.params.fid));

    if (!roleCan(req.session.user, finding.module, "add")) {
        return deny(res, "You cannot add actions to this module's records.");
    }

    await engine.addAction(
        finding.module, finding.record_id, finding.finding_id,
        req.session.user, req.body || {}
    );

    res.redirect(backTo(req, finding.module, finding.record_id));
}));

// Admin only
router.post("/f/:fid/edit", run(async (req, res) => {

    if (!requireAdminHere(req, res)) return;

    const finding = await loadFinding(toId(req.params.fid));

    await engine.updateFinding(finding.finding_id, req.body || {});

    res.redirect(backTo(req, finding.module, finding.record_id));
}));

// Admin only
router.post("/f/:fid/delete", run(async (req, res) => {

    if (!requireAdminHere(req, res)) return;

    const finding = await loadFinding(toId(req.params.fid));

    await engine.deleteFinding(finding.finding_id);

    res.redirect(backTo(req, finding.module, finding.record_id));
}));

// Admin only
router.post("/rc/:rid/delete", run(async (req, res) => {

    if (!requireAdminHere(req, res)) return;

    const [rows] = await db.query(`
        SELECT f.module, f.record_id
        FROM record_root_causes rc JOIN record_findings f ON f.finding_id = rc.finding_id
        WHERE rc.root_cause_id = ?
    `, [toId(req.params.rid)]);

    if (rows.length === 0) throw new EngineError("Root cause not found.", 404);

    await engine.deleteRootCause(toId(req.params.rid));

    res.redirect(backTo(req, rows[0].module, rows[0].record_id));
}));


// =====================================================
// RECORD-LEVEL routes (:module must be a module that has findings)
// =====================================================

function moduleParam(req, res, next) {

    if (!FINDING_MODULES.includes(req.params.module)) {
        return res.status(404).send("Unknown module");
    }

    next();
}

// Add a finding to a record
router.post("/:module/:id/findings", moduleParam, run(async (req, res) => {

    const { module: moduleKey } = req.params;
    const recordId = toId(req.params.id);

    if (!roleCan(req.session.user, moduleKey, "add")) {
        return deny(res, "You cannot add findings to this module's records.");
    }

    if (!(await engine.loadRecordHeader(moduleKey, recordId))) {
        throw new EngineError("Record not found.", 404);
    }

    await engine.addFinding(moduleKey, recordId, req.session.user, req.body || {});

    res.redirect(backTo(req, moduleKey, recordId));
}));

// Add a general action (not tied to a finding), e.g. from meeting minutes
router.post("/:module/:id/actions", moduleParam, run(async (req, res) => {

    const { module: moduleKey } = req.params;
    const recordId = toId(req.params.id);

    if (!roleCan(req.session.user, moduleKey, "add")) {
        return deny(res, "You cannot add actions to this module's records.");
    }

    if (!(await engine.loadRecordHeader(moduleKey, recordId))) {
        throw new EngineError("Record not found.", 404);
    }

    await engine.addAction(moduleKey, recordId, null, req.session.user, req.body || {});

    res.redirect(backTo(req, moduleKey, recordId));
}));


// Save checklist answers. A "Non-compliant" answer raises a finding automatically.
router.post("/:module/:id/checklist", moduleParam, run(async (req, res) => {

    const { module: moduleKey } = req.params;
    const recordId = toId(req.params.id);
    const user = req.session.user;
    const body = req.body || {};

    if (!MODULES[moduleKey].checklists) {
        throw new EngineError("This module has no checklists.", 404);
    }

    if (!roleCan(user, moduleKey, "add")) {
        return deny(res, "You cannot complete checklists for this module.");
    }

    const templateId = toId(body.template_id);

    const [items] = await db.query(`
        SELECT i.item_id, i.question, r.response_id
        FROM checklist_items i
        JOIN checklist_templates t ON t.template_id = i.template_id
        LEFT JOIN checklist_responses r
               ON r.item_id = i.item_id AND r.module = ? AND r.record_id = ?
        WHERE i.template_id = ? AND t.module = ?
        ORDER BY i.sort_order, i.item_id
    `, [moduleKey, recordId, templateId, moduleKey]);

    if (items.length === 0) throw new EngineError("Checklist not found.", 404);

    await engine.withTransaction(async (conn) => {

        for (const item of items) {

            const result = body[`result_${item.item_id}`];
            const comment = clean(body[`comment_${item.item_id}`]).slice(0, 500);

            if (!["Compliant", "Non-compliant", "N/A"].includes(result)) continue;

            // Answers already recorded can only be changed by an Admin.
            if (item.response_id && !isAdmin(user)) continue;

            let findingId = null;

            if (result === "Non-compliant") {

                const [existing] = await conn.query(
                    "SELECT finding_id FROM checklist_responses WHERE module = ? AND record_id = ? AND item_id = ?",
                    [moduleKey, recordId, item.item_id]
                );

                findingId = existing[0] ? existing[0].finding_id : null;

                if (!findingId) {

                    const text = `Checklist non-compliance: ${item.question}` +
                        (comment ? ` - ${comment}` : "");

                    // Responsible: whoever answered the checklist, with their line manager on file.
                    const [f] = await conn.query(`
                        INSERT INTO record_findings
                            (module, record_id, description, severity, responsible_employee_id, line_manager_id, raised_by)
                        SELECT ?, ?, ?, 'Minor', e.employee_id, e.line_manager_id, ?
                        FROM (SELECT 1) one
                        LEFT JOIN employees e ON e.employee_id = ?
                    `, [moduleKey, recordId, text.slice(0, 2000), user.user_id, user.employee_id || null]);

                    findingId = f.insertId;
                }
            }

            await conn.query(`
                INSERT INTO checklist_responses
                    (module, record_id, item_id, result, comment, finding_id, answered_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    result = VALUES(result),
                    comment = VALUES(comment),
                    finding_id = COALESCE(VALUES(finding_id), finding_id),
                    answered_by = VALUES(answered_by)
            `, [moduleKey, recordId, item.item_id, result, comment || null, findingId, user.user_id]);
        }
    });

    // Always come back to this record's own page with the same checklist selected.
    res.redirect(`${recordUrl(moduleKey, recordId)}?template=${templateId}#checklist`);
}));


// =====================================================
// RECORD PAGE
// GET /findings/:module/:id
// =====================================================
router.get("/:module/:id", moduleParam, run(async (req, res) => {

    const { module: moduleKey } = req.params;
    const recordId = toId(req.params.id);
    const user = req.session.user;
    const mod = MODULES[moduleKey];

    if (!recordId) return res.status(404).send("Record not found");

    const record = await engine.loadRecordHeader(moduleKey, recordId);

    if (!record) return res.status(404).send("Record not found");

    const panel = await engine.buildPanel(
        moduleKey, recordId, user, recordUrl(moduleKey, recordId)
    );

    // Checklist (audits / inspections)
    let checklist = null;

    if (mod.checklists) {

        const [templates] = await db.query(`
            SELECT template_id, name
            FROM checklist_templates
            WHERE module = ? AND active = 1
            ORDER BY name
        `, [moduleKey]);

        const [answered] = await db.query(`
            SELECT i.template_id
            FROM checklist_responses r JOIN checklist_items i ON i.item_id = r.item_id
            WHERE r.module = ? AND r.record_id = ?
            GROUP BY i.template_id
            LIMIT 1
        `, [moduleKey, recordId]);

        const chosen =
            toId(req.query.template) ||
            (answered[0] ? answered[0].template_id : null);

        let items = [];

        if (chosen) {
            [items] = await db.query(`
                SELECT i.item_id, i.question, r.result, r.comment, r.finding_id
                FROM checklist_items i
                LEFT JOIN checklist_responses r
                       ON r.item_id = i.item_id AND r.module = ? AND r.record_id = ?
                WHERE i.template_id = ?
                ORDER BY i.sort_order, i.item_id
            `, [moduleKey, recordId, chosen]);
        }

        checklist = { templates, chosen, items };
    }

    res.render("findings/record", {
        title: `Findings & Actions - ${record.title}`,
        record,
        mod,
        moduleKey,
        recordId,
        panel,
        checklist,
        canAdd: roleCan(user, moduleKey, "add"),
        admin: isAdmin(user)
    });
}));


module.exports = router;
