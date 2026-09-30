// =====================================================
// DOCUMENT MANAGEMENT (HSSEQ document control)
//
// Workflow:
//   Author drafts  ->  Reviewer approves  ->  Publisher publishes
//   (a Reviewer or Publisher can return a version to the Author)
//
// Roles come from users.role: "Author", "Reviewer", "Publisher".
// "Admin" can act in all three roles.
// Mounted at /documents in app.js
// =====================================================

const express = require("express");
const router = express.Router();

const db = require("../db");


// =====================================================
// SETTINGS
// =====================================================

// true  = the person who authored a version cannot review or publish it.
// false = one person (e.g. a single Admin) may take a version through every stage.
const ENFORCE_SEGREGATION = true;

const DOC_TYPES = [
    "Policy",
    "Procedure",
    "SOP",
    "Work Instruction",
    "Form",
    "Plan",
    "Register",
    "Manual",
    "Other"
];

// A document can only have one of these at a time.
const OPEN_STATUSES = ["Draft", "In Review", "Returned", "Approved"];

const WORKFLOW_ROLES = {
    author: { label: "Author", roles: ["author", "admin"] },
    reviewer: { label: "Reviewer", roles: ["reviewer", "admin"] },
    publisher: { label: "Publisher", roles: ["publisher", "admin"] }
};


// =====================================================
// ROLE + PERMISSION HELPERS
// =====================================================

function roleName(user) {
    return String((user && user.role) || "").trim().toLowerCase();
}

function hasRole(user, workflowRole) {
    return WORKFLOW_ROLES[workflowRole].roles.includes(roleName(user));
}

// Ordinary users only see published documents.
function canSeeWorkingVersions(user) {
    return Object.keys(WORKFLOW_ROLES).some(r => hasRole(user, r));
}

function requireWorkflowRole(workflowRole) {
    return (req, res, next) => {

        if (hasRole(req.session.user, workflowRole)) {
            return next();
        }

        return res.status(403).send(
            `Access denied: this action requires the ${WORKFLOW_ROLES[workflowRole].label} role.`
        );
    };
}

// What may this user do to this version right now?
// Used by the route guards and by the view (to show/hide buttons).
function versionPermissions(user, version) {

    const isAuthor = version.author_id === user.user_id;
    const isAdmin = roleName(user) === "admin";
    const separated = !ENFORCE_SEGREGATION || !isAuthor;

    const canEdit =
        hasRole(user, "author") &&
        (isAuthor || isAdmin) &&
        ["Draft", "Returned"].includes(version.status);

    const canApprove =
        version.status === "In Review" &&
        hasRole(user, "reviewer") &&
        separated;

    const canPublish =
        version.status === "Approved" &&
        hasRole(user, "publisher") &&
        separated;

    return {
        canEdit,
        canSubmit: canEdit,
        canApprove,
        canPublish,
        canReturn: canApprove || canPublish
    };
}


// =====================================================
// GENERAL HELPERS
// =====================================================

// Thrown for expected failures (bad input, state changed under us).
class WorkflowError extends Error {
    constructor(message, status = 409) {
        super(message);
        this.status = status;
    }
}

function toId(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function pad(n) {
    return String(n).padStart(2, "0");
}

function fmtDate(value) {
    if (!value) return "";
    const d = new Date(value);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(value) {
    if (!value) return "";
    const d = new Date(value);
    return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
}

function oneYearAfter(isoDate) {
    const d = new Date(`${isoDate}T00:00:00`);
    d.setFullYear(d.getFullYear() + 1);
    return fmtDate(d);
}

function clean(value) {
    return String(value || "").trim();
}

async function withTransaction(work) {

    const conn = await db.getConnection();

    try {
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

async function logHistory(conn, version, action, fromStatus, toStatus, comments, userId) {

    await conn.query(`
        INSERT INTO document_history
            (document_id, version_id, action, from_status, to_status, comments, performed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
        version.document_id,
        version.version_id,
        action,
        fromStatus,
        toStatus,
        clean(comments) || null,
        userId
    ]);
}

// Moves a version to a new status, but only if it is still in the
// status we last saw (guards against two people acting at once).
// extraSet is a trusted SQL fragment written in this file; values go in extraParams.
async function moveVersion(conn, version, toStatus, extraSet = "", extraParams = []) {

    const [result] = await conn.query(`
        UPDATE document_versions
        SET status = ?${extraSet ? ", " + extraSet : ""}
        WHERE version_id = ? AND status = ?
    `, [toStatus, ...extraParams, version.version_id, version.status]);

    if (result.affectedRows !== 1) {
        throw new WorkflowError(
            "This version was changed by someone else. Reload the page and try again."
        );
    }
}

async function loadVersion(versionId) {

    const [rows] = await db.query(`
        SELECT
            v.*,
            d.doc_number,
            d.title,
            d.doc_type,
            d.department_id
        FROM document_versions v
        JOIN documents d ON d.document_id = v.document_id
        WHERE v.version_id = ?
    `, [versionId]);

    return rows[0] || null;
}

async function loadDepartments() {

    const [departments] = await db.query(`
        SELECT department_id, department_name
        FROM departments
        ORDER BY department_name
    `);

    return departments;
}

function handleError(res, error, context) {

    if (error instanceof WorkflowError) {
        return res.status(error.status).send(error.message);
    }

    console.error(`Error ${context}:`, error);

    return res.status(500).send(
        `Error ${context}: ${error.sqlMessage || error.message}`
    );
}


// =====================================================
// 1. DOCUMENT LIST + MY WORK QUEUE
// GET /documents
// =====================================================
router.get("/", async (req, res) => {

    const user = req.session.user;
    const working = canSeeWorkingVersions(user);

    const q = clean(req.query.q);
    const type = clean(req.query.type);

    try {

        const where = [];
        const params = [];

        // Ordinary users only see documents that have a published version.
        if (!working) {
            where.push("pv.version_id IS NOT NULL");
        }

        if (q) {
            where.push("(d.doc_number LIKE ? OR d.title LIKE ?)");
            params.push(`%${q}%`, `%${q}%`);
        }

        if (type) {
            where.push("d.doc_type = ?");
            params.push(type);
        }

        const [documents] = await db.query(`
            SELECT
                d.document_id,
                d.doc_number,
                d.title,
                d.doc_type,
                dep.department_name,
                pv.version_no       AS published_version_no,
                pv.published_at,
                pv.review_due_date,
                lv.version_no       AS latest_version_no,
                lv.status           AS latest_status
            FROM documents d
            LEFT JOIN departments dep
                ON dep.department_id = d.department_id
            LEFT JOIN document_versions pv
                ON pv.document_id = d.document_id AND pv.status = 'Published'
            JOIN document_versions lv
                ON lv.document_id = d.document_id
               AND lv.version_no = (
                    SELECT MAX(version_no)
                    FROM document_versions
                    WHERE document_id = d.document_id
               )
            ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY d.doc_number
        `, params);


        // Work queue: versions waiting on something this user can do.
        let queue = [];

        if (working) {

            const [open] = await db.query(`
                SELECT
                    v.version_id,
                    v.document_id,
                    v.version_no,
                    v.status,
                    v.author_id,
                    d.doc_number,
                    d.title
                FROM document_versions v
                JOIN documents d ON d.document_id = v.document_id
                WHERE v.status IN (?)
                ORDER BY v.updated_at
            `, [OPEN_STATUSES]);

            queue = open
                .map(v => {
                    const p = versionPermissions(user, v);
                    const task = p.canEdit ? (v.status === "Returned" ? "Revise & resubmit" : "Edit & submit")
                        : p.canApprove ? "Review"
                        : p.canPublish ? "Publish"
                        : null;
                    return { ...v, task };
                })
                .filter(v => v.task);
        }

        res.render("documents/index", {
            title: "Document Management",
            documents,
            queue,
            docTypes: DOC_TYPES,
            filters: { q, type },
            canAuthor: hasRole(user, "author"),
            working,
            fmtDate
        });

    } catch (error) {
        handleError(res, error, "loading documents");
    }
});


// =====================================================
// 2. NEW DOCUMENT FORM
// GET /documents/add
// =====================================================
router.get("/add", requireWorkflowRole("author"), async (req, res) => {

    try {

        res.render("documents/add", {
            title: "New Document",
            error: null,
            values: {},
            departments: await loadDepartments(),
            docTypes: DOC_TYPES
        });

    } catch (error) {
        handleError(res, error, "loading the new document form");
    }
});


// =====================================================
// 3. CREATE DOCUMENT (+ version 1 as a draft)
// POST /documents/add
// =====================================================
router.post("/add", requireWorkflowRole("author"), async (req, res) => {

    const body = req.body || {};
    const user = req.session.user;

    const values = {
        doc_number: clean(body.doc_number),
        title: clean(body.title),
        doc_type: clean(body.doc_type),
        department_id: toId(body.department_id),
        content: String(body.content || ""),
        change_summary: clean(body.change_summary)
    };

    const showForm = async (message) => {
        res.status(400).render("documents/add", {
            title: "New Document",
            error: message,
            values,
            departments: await loadDepartments(),
            docTypes: DOC_TYPES
        });
    };

    try {

        if (!values.doc_number || !values.title || !values.content.trim()) {
            return await showForm("Document number, title and content are required.");
        }

        if (!DOC_TYPES.includes(values.doc_type)) {
            return await showForm("Please choose a document type.");
        }

        const versionId = await withTransaction(async (conn) => {

            const [doc] = await conn.query(`
                INSERT INTO documents
                    (doc_number, title, doc_type, department_id, created_by)
                VALUES (?, ?, ?, ?, ?)
            `, [
                values.doc_number,
                values.title,
                values.doc_type,
                values.department_id,
                user.user_id
            ]);

            const [version] = await conn.query(`
                INSERT INTO document_versions
                    (document_id, version_no, content, change_summary, status, author_id)
                VALUES (?, 1, ?, ?, 'Draft', ?)
            `, [
                doc.insertId,
                values.content,
                values.change_summary || "Initial version",
                user.user_id
            ]);

            await logHistory(
                conn,
                { document_id: doc.insertId, version_id: version.insertId },
                "Created", null, "Draft", null, user.user_id
            );

            return version.insertId;
        });

        const created = await loadVersion(versionId);

        res.redirect(`/documents/${created.document_id}`);

    } catch (error) {

        if (error.code === "ER_DUP_ENTRY") {
            return await showForm(`Document number "${values.doc_number}" already exists.`);
        }

        handleError(res, error, "creating the document");
    }
});


// =====================================================
// 4. EDIT FORM FOR A DRAFT / RETURNED VERSION
// GET /documents/versions/:versionId/edit
// =====================================================
router.get("/versions/:versionId/edit", async (req, res) => {

    const versionId = toId(req.params.versionId);

    if (!versionId) {
        return res.status(404).send("Version not found");
    }

    try {

        const version = await loadVersion(versionId);

        if (!version) {
            return res.status(404).send("Version not found");
        }

        if (!versionPermissions(req.session.user, version).canEdit) {
            return res.status(403).send(
                "You cannot edit this version (wrong role, wrong status, or it belongs to another author)."
            );
        }

        res.render("documents/edit", {
            title: `Edit ${version.doc_number}`,
            error: null,
            version,
            values: version,
            departments: await loadDepartments(),
            docTypes: DOC_TYPES
        });

    } catch (error) {
        handleError(res, error, "loading the edit page");
    }
});


// =====================================================
// 5. SAVE EDITS
// POST /documents/versions/:versionId/edit
// =====================================================
router.post("/versions/:versionId/edit", async (req, res) => {

    const versionId = toId(req.params.versionId);
    const body = req.body || {};
    const user = req.session.user;

    if (!versionId) {
        return res.status(404).send("Version not found");
    }

    try {

        const version = await loadVersion(versionId);

        if (!version) {
            return res.status(404).send("Version not found");
        }

        if (!versionPermissions(user, version).canEdit) {
            return res.status(403).send(
                "You cannot edit this version (wrong role, wrong status, or it belongs to another author)."
            );
        }

        // Title, type and department can only change before the first publication.
        const editMeta = version.version_no === 1;

        const values = {
            ...version,
            title: editMeta ? clean(body.title) : version.title,
            doc_type: editMeta ? clean(body.doc_type) : version.doc_type,
            department_id: editMeta ? toId(body.department_id) : version.department_id,
            content: String(body.content || ""),
            change_summary: clean(body.change_summary)
        };

        const showForm = async (message) => {
            res.status(400).render("documents/edit", {
                title: `Edit ${version.doc_number}`,
                error: message,
                version,
                values,
                departments: await loadDepartments(),
                docTypes: DOC_TYPES
            });
        };

        if (!values.title || !values.content.trim()) {
            return await showForm("Title and content are required.");
        }

        if (!DOC_TYPES.includes(values.doc_type)) {
            return await showForm("Please choose a document type.");
        }

        await withTransaction(async (conn) => {

            const [result] = await conn.query(`
                UPDATE document_versions
                SET content = ?, change_summary = ?
                WHERE version_id = ? AND status IN ('Draft', 'Returned')
            `, [values.content, values.change_summary || null, versionId]);

            if (result.affectedRows !== 1) {
                throw new WorkflowError(
                    "This version can no longer be edited. Reload the page."
                );
            }

            if (editMeta) {
                await conn.query(`
                    UPDATE documents
                    SET title = ?, doc_type = ?, department_id = ?
                    WHERE document_id = ?
                `, [
                    values.title,
                    values.doc_type,
                    values.department_id,
                    version.document_id
                ]);
            }

            await logHistory(
                conn, version, "Edited", version.status, version.status,
                values.change_summary, user.user_id
            );
        });

        res.redirect(`/documents/${version.document_id}?v=${version.version_no}`);

    } catch (error) {
        handleError(res, error, "saving the document");
    }
});


// =====================================================
// 6. WORKFLOW ACTIONS ON A VERSION
// POST /documents/versions/:versionId/{submit|approve|return|publish}
// =====================================================

// Loads the version, checks the user's permission for it, runs the
// handler inside a transaction, then goes back to the document page.
function workflowAction(permission, handler) {

    return async (req, res) => {

        const versionId = toId(req.params.versionId);

        if (!versionId) {
            return res.status(404).send("Version not found");
        }

        try {

            const version = await loadVersion(versionId);

            if (!version) {
                return res.status(404).send("Version not found");
            }

            const user = req.session.user;

            if (!versionPermissions(user, version)[permission]) {
                return res.status(403).send(
                    "You cannot do this on this version (wrong role, wrong status, or you authored it)."
                );
            }

            await withTransaction(conn =>
                handler({ conn, version, user, body: req.body || {} })
            );

            res.redirect(`/documents/${version.document_id}?v=${version.version_no}`);

        } catch (error) {
            handleError(res, error, "updating the document workflow");
        }
    };
}


// Author -> Reviewer
router.post("/versions/:versionId/submit", workflowAction("canSubmit",
    async ({ conn, version, user, body }) => {

        await moveVersion(conn, version, "In Review", "reviewer_id = NULL, reviewed_at = NULL");

        await logHistory(
            conn, version, "Submitted", version.status, "In Review",
            body.comments, user.user_id
        );
    }
));


// Reviewer approves -> ready for the Publisher
router.post("/versions/:versionId/approve", workflowAction("canApprove",
    async ({ conn, version, user, body }) => {

        await moveVersion(
            conn, version, "Approved",
            "reviewer_id = ?, reviewed_at = NOW()", [user.user_id]
        );

        await logHistory(
            conn, version, "Approved", version.status, "Approved",
            body.comments, user.user_id
        );
    }
));


// Reviewer (from In Review) or Publisher (from Approved) sends it back to the Author
router.post("/versions/:versionId/return", workflowAction("canReturn",
    async ({ conn, version, user, body }) => {

        if (!clean(body.comments)) {
            throw new WorkflowError(
                "Comments are required when returning a version for changes.", 400
            );
        }

        await moveVersion(conn, version, "Returned", "reviewer_id = NULL, reviewed_at = NULL");

        await logHistory(
            conn, version, "Returned", version.status, "Returned",
            body.comments, user.user_id
        );
    }
));


// Publisher publishes; the previously published version becomes Superseded
router.post("/versions/:versionId/publish", workflowAction("canPublish",
    async ({ conn, version, user, body }) => {

        const effectiveDate = clean(body.effective_date) || fmtDate(new Date());
        const reviewDueDate = clean(body.review_due_date) || oneYearAfter(effectiveDate);

        if (!isIsoDate(effectiveDate) || !isIsoDate(reviewDueDate)) {
            throw new WorkflowError("Please enter valid dates.", 400);
        }

        if (reviewDueDate < effectiveDate) {
            throw new WorkflowError(
                "The review due date cannot be before the effective date.", 400
            );
        }

        // Serialise publishes of the same document.
        await conn.query(
            "SELECT document_id FROM documents WHERE document_id = ? FOR UPDATE",
            [version.document_id]
        );

        const [previous] = await conn.query(`
            SELECT version_id, version_no
            FROM document_versions
            WHERE document_id = ? AND status = 'Published' AND version_id <> ?
        `, [version.document_id, version.version_id]);

        await moveVersion(
            conn, version, "Published",
            "publisher_id = ?, published_at = NOW(), effective_date = ?, review_due_date = ?",
            [user.user_id, effectiveDate, reviewDueDate]
        );

        for (const old of previous) {

            await conn.query(
                "UPDATE document_versions SET status = 'Superseded' WHERE version_id = ?",
                [old.version_id]
            );

            await logHistory(
                conn,
                { document_id: version.document_id, version_id: old.version_id },
                "Superseded", "Published", "Superseded",
                `Superseded by v${version.version_no}`, user.user_id
            );
        }

        await logHistory(
            conn, version, "Published", "Approved", "Published",
            body.comments, user.user_id
        );
    }
));


// =====================================================
// 7. START A NEW VERSION OF A PUBLISHED DOCUMENT
// POST /documents/:id/new-version
// Copies the latest content into a fresh draft.
// =====================================================
router.post("/:id/new-version", requireWorkflowRole("author"), async (req, res) => {

    const documentId = toId(req.params.id);
    const user = req.session.user;

    if (!documentId) {
        return res.status(404).send("Document not found");
    }

    try {

        const newVersionId = await withTransaction(async (conn) => {

            const [docs] = await conn.query(
                "SELECT document_id FROM documents WHERE document_id = ? FOR UPDATE",
                [documentId]
            );

            if (docs.length === 0) {
                throw new WorkflowError("Document not found", 404);
            }

            const [open] = await conn.query(`
                SELECT version_id
                FROM document_versions
                WHERE document_id = ? AND status IN (?)
            `, [documentId, OPEN_STATUSES]);

            if (open.length > 0) {
                throw new WorkflowError(
                    "This document already has a version in progress."
                );
            }

            const [latest] = await conn.query(`
                SELECT version_no, content
                FROM document_versions
                WHERE document_id = ?
                ORDER BY version_no DESC
                LIMIT 1
            `, [documentId]);

            const [inserted] = await conn.query(`
                INSERT INTO document_versions
                    (document_id, version_no, content, status, author_id)
                VALUES (?, ?, ?, 'Draft', ?)
            `, [
                documentId,
                latest[0].version_no + 1,
                latest[0].content,
                user.user_id
            ]);

            await logHistory(
                conn,
                { document_id: documentId, version_id: inserted.insertId },
                "New version", null, "Draft",
                `Started from v${latest[0].version_no}`, user.user_id
            );

            return inserted.insertId;
        });

        res.redirect(`/documents/versions/${newVersionId}/edit`);

    } catch (error) {
        handleError(res, error, "creating a new version");
    }
});


// =====================================================
// 8. VIEW A DOCUMENT
// GET /documents/:id            -> published version (or latest, for staff)
// GET /documents/:id?v=<no>     -> a specific version
// =====================================================
router.get("/:id", async (req, res) => {

    const documentId = toId(req.params.id);
    const user = req.session.user;

    if (!documentId) {
        return res.status(404).send("Document not found");
    }

    try {

        const [docs] = await db.query(`
            SELECT d.*, dep.department_name
            FROM documents d
            LEFT JOIN departments dep ON dep.department_id = d.department_id
            WHERE d.document_id = ?
        `, [documentId]);

        if (docs.length === 0) {
            return res.status(404).send("Document not found");
        }

        const [allVersions] = await db.query(`
            SELECT
                v.*,
                a.username AS author_name,
                r.username AS reviewer_name,
                p.username AS publisher_name
            FROM document_versions v
            LEFT JOIN users a ON a.user_id = v.author_id
            LEFT JOIN users r ON r.user_id = v.reviewer_id
            LEFT JOIN users p ON p.user_id = v.publisher_id
            WHERE v.document_id = ?
            ORDER BY v.version_no DESC
        `, [documentId]);

        const working = canSeeWorkingVersions(user);

        const versions = working
            ? allVersions
            : allVersions.filter(v => v.status === "Published");

        if (versions.length === 0) {
            return res.status(404).send("Document not found");
        }

        const requested = toId(req.query.v);

        const version =
            versions.find(v => v.version_no === requested) ||
            versions.find(v => v.status === "Published") ||
            versions[0];

        const perms = versionPermissions(user, version);

        const hasOpenVersion = allVersions.some(v => OPEN_STATUSES.includes(v.status));

        let history = [];

        if (working) {

            [history] = await db.query(`
                SELECT
                    h.*,
                    v.version_no,
                    u.username AS performed_by_name
                FROM document_history h
                JOIN document_versions v ON v.version_id = h.version_id
                LEFT JOIN users u ON u.user_id = h.performed_by
                WHERE h.document_id = ?
                ORDER BY h.performed_at DESC, h.history_id DESC
            `, [documentId]);
        }

        const today = fmtDate(new Date());

        res.render("documents/view", {
            title: `${docs[0].doc_number} - ${docs[0].title}`,
            doc: docs[0],
            versions,
            version,
            perms,
            history,
            working,
            canStartNewVersion: hasRole(user, "author") && !hasOpenVersion,
            publishDefaults: { effective: today, reviewDue: oneYearAfter(today) },
            segregation: ENFORCE_SEGREGATION,
            fmtDate,
            fmtDateTime
        });

    } catch (error) {
        handleError(res, error, "viewing the document");
    }
});


module.exports = router;
