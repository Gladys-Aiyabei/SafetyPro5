// =====================================================
// USER ACCOUNTS (the `users` table)
//
//   user_id      int, auto_increment, primary key
//   username     varchar(50), required, unique
//   email        varchar(100), required, unique (this is what people log in with)
//   password     varchar(255), required (always a bcrypt hash, never shown)
//   role         varchar(50), default 'User'
//   employee_id  int, optional, links to employees
//   status       varchar(30), default 'Active'
//   created_at   timestamp, set by the database
//
// Used by the Users module (routes/users.js) and the dashboard Users sheet.
// Only Admins reach either; the routes enforce that with requireAdmin.
// =====================================================

const bcrypt = require("bcryptjs");
const db = require("../db");

// Roles a user account can have (the values already stored in users.role).
const ROLES = ["Admin", "User", "Author", "Reviewer", "Publisher", "Permit issuer", "Risk assessor"];
const STATUSES = ["Active", "Inactive"];

const sql = async (text, params = []) => (await db.query(text, params))[0];

const isActive = u => String(u.status || "").trim().toLowerCase() === "active";
const hasRole = (u, role) => String(u.role || "").trim().toLowerCase() === role;


// =====================================================
// READ
// =====================================================

// Every user, with the linked employee. Optional filters: q (text), role, status.
async function listUsers({ q = "", role = "", status = "" } = {}) {

    const where = [];
    const params = [];

    if (q) {
        where.push("(u.username LIKE ? OR u.email LIKE ? OR e.employee_name LIKE ?)");
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (role) { where.push("u.role = ?"); params.push(role); }
    if (status) { where.push("u.status = ?"); params.push(status); }

    return sql(`
        SELECT u.user_id, u.username, u.email, u.role, u.status, u.employee_id, u.created_at, e.employee_name
        FROM users u
        LEFT JOIN employees e ON e.employee_id = u.employee_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY u.username`, params);
}

// One user (password hash deliberately not selected).
async function getUser(id) {

    const [row] = await sql(`
        SELECT u.user_id, u.username, u.email, u.role, u.status, u.employee_id, u.created_at,
               e.employee_name, d.department_name
        FROM users u
        LEFT JOIN employees e ON e.employee_id = u.employee_id
        LEFT JOIN departments d ON d.department_id = e.department_id
        WHERE u.user_id = ?`, [id]);

    return row || null;
}

// For the "linked employee" drop-down.
async function employeeChoices() {
    return sql("SELECT employee_id, employee_name FROM employees ORDER BY employee_name");
}


// =====================================================
// VALIDATION
// =====================================================

// `fixed` ({ role, status }) overrides the submitted role and status. It is used when
// an admin edits their own account, so they cannot demote or deactivate themselves.
function readForm(body, requirePassword, fixed = null) {

    const username = String(body.username || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const role = fixed ? fixed.role
        : ROLES.find(r => r.toLowerCase() === String(body.role || "").trim().toLowerCase());
    const status = fixed ? fixed.status
        : STATUSES.find(s => s.toLowerCase() === String(body.status || "").trim().toLowerCase());
    const employeeId = /^\d+$/.test(String(body.employee_id || "")) ? Number(body.employee_id) : null;
    const password = String(body.password || "");

    const errors = [];

    if (username.length < 3 || username.length > 50) errors.push("Username must be 3 to 50 characters.");
    if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Enter a valid email address.");
    if (!role) errors.push("Choose a role.");
    if (!status) errors.push("Choose a status.");

    if (requirePassword || password) {
        if (password.length < 8) errors.push("Password must be at least 8 characters.");
        else if (Buffer.byteLength(password) > 72) errors.push("Password is too long (72 bytes at most).");
    }

    return {
        v: { username, email, role, status, employeeId, password },
        // what to show again in the form after a rejected save (the password is never kept)
        form: { username, email, role: role || "", status: status || "", employee_id: employeeId || "" },
        errors
    };
}

async function employeeMissing(employeeId) {
    if (!employeeId) return false;
    return (await sql("SELECT 1 FROM employees WHERE employee_id = ?", [employeeId])).length === 0;
}

function saveError(error) {

    if (error.code === "ER_DUP_ENTRY") {
        return /email/i.test(error.sqlMessage || "")
            ? "That email address is already used by another user."
            : "That username is already taken.";
    }

    console.error("Users error:", error);
    return "The user could not be saved: " + (error.sqlMessage || error.message);
}


// =====================================================
// WRITE   each returns { ok, message, form? }
// =====================================================

async function createUser(body) {

    const { v, form, errors } = readForm(body, true);

    try {

        if (await employeeMissing(v.employeeId)) errors.push("The selected employee was not found.");

        if (errors.length) return { ok: false, message: errors.join(" "), form };

        const hash = await bcrypt.hash(v.password, 10);

        const [result] = await db.query(
            `INSERT INTO users (username, email, password, role, employee_id, status) VALUES (?, ?, ?, ?, ?, ?)`,
            [v.username, v.email, hash, v.role, v.employeeId, v.status]
        );

        return { ok: true, message: `User "${v.username}" was added.`, id: result.insertId };

    } catch (error) {
        return { ok: false, message: saveError(error), form };
    }
}

// `actor` is the logged-in admin's session user; their own session is kept in step.
async function updateUser(id, body, actor) {

    const [target] = await sql("SELECT user_id, role, status FROM users WHERE user_id = ?", [id]);

    if (!target) return { ok: false, missing: true, message: "That user no longer exists." };

    const self = !!actor && id === actor.user_id;
    const { v, form, errors } = readForm(body, false, self ? { role: target.role, status: target.status } : null);

    try {

        if (await employeeMissing(v.employeeId)) errors.push("The selected employee was not found.");

        if (errors.length) return { ok: false, message: errors.join(" "), form };

        const sets = ["username = ?", "email = ?", "role = ?", "employee_id = ?", "status = ?"];
        const params = [v.username, v.email, v.role, v.employeeId, v.status];

        if (v.password) {
            sets.push("password = ?");
            params.push(await bcrypt.hash(v.password, 10));
        }

        await db.query(`UPDATE users SET ${sets.join(", ")} WHERE user_id = ?`, [...params, id]);

        if (self) Object.assign(actor, { username: v.username, email: v.email, employee_id: v.employeeId });

        return {
            ok: true,
            message: `User "${v.username}" was updated.` + (v.password ? " The password was changed." : "")
        };

    } catch (error) {
        return { ok: false, message: saveError(error), form };
    }
}

async function deleteUser(id, actor) {

    if (actor && id === actor.user_id) {
        return { ok: false, message: "You cannot delete your own account." };
    }

    const [target] = await sql("SELECT username FROM users WHERE user_id = ?", [id]);

    if (!target) return { ok: false, missing: true, message: "That user no longer exists." };

    try {

        await db.query("DELETE FROM users WHERE user_id = ?", [id]);

        return { ok: true, message: `User "${target.username}" was deleted.` };

    } catch (error) {

        // Document authors, reviewers and publishers are referenced by document records.
        if (error.errno === 1451) {
            return {
                ok: false,
                message: "This user has document records and cannot be deleted. Set the account to Inactive instead."
            };
        }

        console.error("Users error:", error);
        return { ok: false, message: "The user could not be deleted: " + (error.sqlMessage || error.message) };
    }
}


module.exports = {
    ROLES,
    STATUSES,
    isActive,
    hasRole,
    listUsers,
    getUser,
    employeeChoices,
    createUser,
    updateUser,
    deleteUser
};
