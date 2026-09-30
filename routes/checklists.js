// =====================================================
// CHECKLISTS FOR AUDITS AND INSPECTIONS (Admin only)
// Mounted at /checklists in app.js behind requireAdmin.
//
// Admins build the checklists here. When someone audits or inspects, they answer
// the checklist on the record's Findings page; a "Non-compliant" answer raises a finding.
// =====================================================

const express = require("express");
const router = express.Router();

const db = require("../db");
const { toId } = require("../lib/engine");
const { optionalText } = require("../lib/lookups");

const CHECKLIST_MODULES = { audits: "Audits", inspections: "Inspections" };

// One question per line; blank lines and leading numbering/bullets are ignored.
function parseQuestions(text) {

    return String(text || "")
        .split(/\r?\n/)
        .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter(Boolean)
        .map(q => q.slice(0, 1000));
}


// =====================================================
// LIST  GET /checklists
// =====================================================
router.get("/", async (req, res) => {

    try {

        const [templates] = await db.query(`
            SELECT t.*,
                   (SELECT COUNT(*) FROM checklist_items i WHERE i.template_id = t.template_id) AS items,
                   (SELECT COUNT(DISTINCT r.module, r.record_id)
                      FROM checklist_responses r
                      JOIN checklist_items i ON i.item_id = r.item_id
                     WHERE i.template_id = t.template_id) AS uses
            FROM checklist_templates t
            ORDER BY t.module, t.name
        `);

        res.render("checklists/index", {
            title: "Checklists",
            templates,
            modules: CHECKLIST_MODULES
        });

    } catch (error) {
        console.error("Error loading checklists:", error);
        res.status(500).send("Error loading checklists");
    }
});


// =====================================================
// NEW  GET/POST /checklists/new
// =====================================================
router.get("/new", (req, res) => {

    res.render("checklists/new", {
        title: "New Checklist",
        error: null,
        values: { module: req.query.module || "audits" },
        modules: CHECKLIST_MODULES
    });
});

router.post("/new", async (req, res) => {

    const body = req.body || {};

    const values = {
        module: CHECKLIST_MODULES[body.module] ? body.module : "audits",
        name: String(body.name || "").trim(),
        description: optionalText(body.description),
        questions: String(body.questions || "")
    };

    const fail = (message) => res.status(400).render("checklists/new", {
        title: "New Checklist", error: message, values, modules: CHECKLIST_MODULES
    });

    try {

        const questions = parseQuestions(values.questions);

        if (!values.name) return fail("Give the checklist a name.");
        if (questions.length === 0) return fail("Add at least one question (one per line).");

        const conn = await db.getConnection();

        try {

            await conn.beginTransaction();

            const [t] = await conn.query(`
                INSERT INTO checklist_templates (module, name, description, created_by)
                VALUES (?, ?, ?, ?)
            `, [values.module, values.name.slice(0, 150), values.description, req.session.user.user_id]);

            for (const [i, q] of questions.entries()) {
                await conn.query(
                    "INSERT INTO checklist_items (template_id, sort_order, question) VALUES (?, ?, ?)",
                    [t.insertId, i + 1, q]
                );
            }

            await conn.commit();

            res.redirect(`/checklists/${t.insertId}`);

        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }

    } catch (error) {

        if (error.code === "ER_DUP_ENTRY") {
            return fail(`A checklist named "${values.name}" already exists for that module.`);
        }

        console.error("Error creating checklist:", error);
        res.status(500).send(`Error creating the checklist: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// EDIT  GET /checklists/:id   POST /checklists/:id
// =====================================================
router.get("/:id", async (req, res) => {

    try {

        const id = toId(req.params.id);

        const [templates] = await db.query("SELECT * FROM checklist_templates WHERE template_id = ?", [id]);

        if (templates.length === 0) return res.status(404).send("Checklist not found");

        const [items] = await db.query(`
            SELECT i.*, (SELECT COUNT(*) FROM checklist_responses r WHERE r.item_id = i.item_id) AS answers
            FROM checklist_items i
            WHERE i.template_id = ?
            ORDER BY i.sort_order, i.item_id
        `, [id]);

        res.render("checklists/edit", {
            title: `Checklist: ${templates[0].name}`,
            template: templates[0],
            items,
            modules: CHECKLIST_MODULES,
            error: null
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading the checklist");
    }
});

router.post("/:id", async (req, res) => {

    try {

        const id = toId(req.params.id);
        const body = req.body || {};

        const name = String(body.name || "").trim();

        if (!name) return res.status(400).send("A checklist needs a name.");

        await db.query(`
            UPDATE checklist_templates
            SET name = ?, description = ?, active = ?
            WHERE template_id = ?
        `, [name.slice(0, 150), optionalText(body.description), body.active ? 1 : 0, id]);

        const questions = parseQuestions(body.new_questions);

        if (questions.length > 0) {

            const [[max]] = await db.query(
                "SELECT COALESCE(MAX(sort_order), 0) AS n FROM checklist_items WHERE template_id = ?", [id]
            );

            for (const [i, q] of questions.entries()) {
                await db.query(
                    "INSERT INTO checklist_items (template_id, sort_order, question) VALUES (?, ?, ?)",
                    [id, max.n + i + 1, q]
                );
            }
        }

        res.redirect(`/checklists/${id}`);

    } catch (error) {

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).send("Another checklist for this module already has that name.");
        }

        console.error("Error updating checklist:", error);
        res.status(500).send("Error updating the checklist");
    }
});

router.post("/:id/items/:itemId/delete", async (req, res) => {

    try {

        await db.query(
            "DELETE FROM checklist_items WHERE item_id = ? AND template_id = ?",
            [toId(req.params.itemId), toId(req.params.id)]
        );

        res.redirect(`/checklists/${toId(req.params.id)}`);

    } catch (error) {
        console.error(error);
        res.status(500).send("Error removing the question");
    }
});

router.post("/:id/delete", async (req, res) => {

    try {

        await db.query("DELETE FROM checklist_templates WHERE template_id = ?", [toId(req.params.id)]);

        res.redirect("/checklists");

    } catch (error) {
        console.error(error);
        res.status(500).send("Error deleting the checklist");
    }
});


module.exports = router;
