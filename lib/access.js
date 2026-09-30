// =====================================================
// ACCESS CONTROL (one place for every "who may do what" rule)
//
//   * Only Admin deletes anything.
//   * Normal users may view and add records, but not edit.
//   * Permits and risk assessments: only trained Permit issuers / Risk assessors
//     may add or edit, and only while their training is under 2 years old.
//   * Employees and departments are master data: Admin only.
// =====================================================

const db = require("../db");


// =====================================================
// SETTINGS
// =====================================================

// PTW / Risk assessment training is valid for this many years from the training date.
const TRAINING_VALIDITY_YEARS = 2;

// false = Admin can only VIEW and DELETE permits / risk assessments, like the brief says
//         ("only trained issuers/assessors may edit"). Set true to let Admin edit them too
//         (the training check below still applies).
const ADMIN_MAY_EDIT_RESTRICTED = false;

// true = the person who completed an action cannot also approve it.
const ENFORCE_SEGREGATION = true;

// Modules whose add/edit is limited to a specific trained role.
const RESTRICTED = {
    permits: {
        role: "permit issuer",
        training: "ptw",
        trainingLabel: "Permit to Work"
    },
    risks: {
        role: "risk assessor",
        training: "risk",
        trainingLabel: "Risk Assessment"
    }
};

// Training name patterns (matched against training.training_name).
const TRAINING_PATTERNS = {
    ptw: ["%permit to work%", "%ptw%", "%permit issuer%"],
    risk: ["%risk assessment%"]
};

// Master data: only Admin may add / edit.
const ADMIN_ONLY = ["employees", "departments", "requirements"];


// =====================================================
// ROLE HELPERS
// =====================================================

function roleName(user) {
    return String((user && user.role) || "").trim().toLowerCase();
}

function isAdmin(user) {
    return roleName(user) === "admin";
}

// Role-based permission only (training is checked separately, see trainingStatus).
function roleCan(user, moduleKey, action) {

    if (!user) return false;

    const admin = isAdmin(user);

    if (action === "delete") return admin;

    if (ADMIN_ONLY.includes(moduleKey)) return admin;

    const restricted = RESTRICTED[moduleKey];

    if (restricted) {
        if (action === "add" || action === "edit") {
            return roleName(user) === restricted.role ||
                (admin && ADMIN_MAY_EDIT_RESTRICTED);
        }
        return false;
    }

    if (action === "add") return true;
    if (action === "edit") return admin;

    return false;
}


// =====================================================
// TRAINING VALIDITY (permit issuers / risk assessors)
// =====================================================

function iso(d) {
    const x = new Date(d);
    const p = n => String(n).padStart(2, "0");
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

// Returns { ok, message, expires, trained_on } for the user's employee record.
async function trainingStatus(user, kind) {

    const label = kind === "ptw" ? "Permit to Work" : "Risk Assessment";

    if (!user || !user.employee_id) {
        return {
            ok: false,
            message: `Your user account is not linked to an employee record, so your ${label} training cannot be verified.`
        };
    }

    const patterns = TRAINING_PATTERNS[kind];

    const [rows] = await db.query(`
        SELECT training_name, training_date, expiry_date
        FROM training
        WHERE employee_id = ?
          AND endorsed_at IS NOT NULL
          AND COALESCE(status, '') NOT IN ('Cancelled', 'Failed')
          AND (${patterns.map(() => "LOWER(training_name) LIKE ?").join(" OR ")})
        ORDER BY training_date DESC
        LIMIT 1
    `, [user.employee_id, ...patterns]);

    if (rows.length === 0) {
        return {
            ok: false,
            message: `No endorsed ${label} training record was found for you. Ask a line manager to record and endorse it.`
        };
    }

    const t = rows[0];

    const trainedOn = new Date(t.training_date);

    const byAge = new Date(trainedOn);
    byAge.setFullYear(byAge.getFullYear() + TRAINING_VALIDITY_YEARS);

    let expires = byAge;

    if (t.expiry_date && new Date(t.expiry_date) < expires) {
        expires = new Date(t.expiry_date);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (expires < today) {
        return {
            ok: false,
            message: `Your ${label} training expired on ${iso(expires)}. Renew it before you can add or edit records here.`,
            expires: iso(expires),
            trained_on: iso(trainedOn)
        };
    }

    return {
        ok: true,
        message: null,
        expires: iso(expires),
        trained_on: iso(trainedOn)
    };
}


// =====================================================
// MODULE GUARD
// Mount in front of a module's routes:  app.use("/incidents", requireLogin, guard("incidents"), routes)
//
//  - sets res.locals.can = { add, edit, delete } for the views
//  - blocks add / edit / delete requests the user may not make
// =====================================================

// Works out what a request is trying to do from its URL pattern.
function classify(req) {

    const p = req.path;

    if (/\/delete(\/|$)/.test(p)) return "delete";
    if (/\/(edit|update)(\/|$)/.test(p)) return "edit";
    if (/(^|\/)add(\/|$)/.test(p)) return "add";
    if (req.method === "POST" && (p === "/" || p === "")) return "add";

    return null;
}

function deny(res, message) {
    return res.status(403).send(`
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:80px auto;padding:28px;border:1px solid #f5c2c7;border-radius:8px;background:#fff5f5">
            <h2 style="margin-top:0;color:#b02a37">Access denied</h2>
            <p>${message}</p>
            <p><a href="javascript:history.back()">&larr; Go back</a></p>
        </div>
    `);
}

function guard(moduleKey) {

    return async (req, res, next) => {

        try {

            const user = req.session.user;
            const restricted = RESTRICTED[moduleKey];

            const can = {
                add: roleCan(user, moduleKey, "add"),
                edit: roleCan(user, moduleKey, "edit"),
                delete: roleCan(user, moduleKey, "delete")
            };

            let trainingBlock = null;

            if (restricted && (can.add || can.edit)) {

                const status = await trainingStatus(user, restricted.training);

                if (!status.ok) {
                    trainingBlock = status.message;
                    can.add = false;
                    can.edit = false;
                }
            }

            res.locals.can = can;
            res.locals.moduleKey = moduleKey;
            res.locals.trainingNotice = trainingBlock;

            const action = classify(req);

            if (action && !can[action]) {

                if (trainingBlock && (action === "add" || action === "edit")) {
                    return deny(res, trainingBlock);
                }

                const who = action === "delete"
                    ? "Only an Admin can delete records."
                    : restricted
                        ? `Only a trained ${restricted.trainingLabel} ${restricted.role === "permit issuer" ? "issuer" : "assessor"} can ${action} records here.`
                        : action === "edit"
                            ? "Normal users can view and add records but cannot edit them."
                            : "You do not have permission to add records here.";

                return deny(res, who);
            }

            // Remove findings/actions left behind by a deleted record.
            if (action === "delete") {
                res.on("finish", () => {
                    purgeOrphans(moduleKey).catch(err =>
                        console.error("Orphan cleanup failed:", err.message)
                    );
                });
            }

            next();

        } catch (error) {
            next(error);
        }
    };
}

async function purgeOrphans(moduleKey) {

    await db.query(`
        DELETE FROM record_findings
        WHERE module = ?
          AND record_id NOT IN (SELECT record_id FROM v_records WHERE module = ?)
    `, [moduleKey, moduleKey]);

    await db.query(`
        DELETE FROM record_actions
        WHERE module = ? AND finding_id IS NULL
          AND record_id NOT IN (SELECT record_id FROM v_records WHERE module = ?)
    `, [moduleKey, moduleKey]);
}


// Same rules as guard() but for code that adds records itself (bulk upload):
// { ok: true } or { ok: false, message }
async function canAddNow(user, moduleKey) {

    if (!roleCan(user, moduleKey, "add")) {

        const restricted = RESTRICTED[moduleKey];

        return {
            ok: false,
            message: restricted
                ? `Only a trained ${restricted.trainingLabel} ${restricted.role === "permit issuer" ? "issuer" : "assessor"} can add records here.`
                : "You do not have permission to add records to this module."
        };
    }

    const restricted = RESTRICTED[moduleKey];

    if (restricted) {

        const status = await trainingStatus(user, restricted.training);

        if (!status.ok) return { ok: false, message: status.message };
    }

    return { ok: true };
}


// Simple gate for Admin-only routes.
function requireAdmin(req, res, next) {

    if (isAdmin(req.session.user)) return next();

    return deny(res, "Only an Admin can do this.");
}


module.exports = {
    TRAINING_VALIDITY_YEARS,
    ENFORCE_SEGREGATION,
    RESTRICTED,
    roleName,
    isAdmin,
    roleCan,
    trainingStatus,
    canAddNow,
    guard,
    deny,
    requireAdmin
};
