// =====================================================
// FINDINGS -> ROOT CAUSES -> ACTIONS ENGINE
//
//  * A record (of any module) has many findings.
//  * A finding has many root causes and many actions.
//  * An action has a due date and is tied to a ROLE. Whoever holds that role right
//    now is responsible (view v_action_owners), so new staff inherit actions automatically.
//  * An action only closes after the owner's LINE MANAGER approves it.
//  * When every action of a finding is closed, the finding closes by itself.
// =====================================================

const db = require("../db");
const { isAdmin, roleName, roleCan, ENFORCE_SEGREGATION } = require("./access");


// =====================================================
// LISTS
// =====================================================

const SEVERITIES = ["Observation", "Minor", "Major", "Critical"];

const ROOT_CAUSE_CATEGORIES = [
    "People / Human factors",
    "Process / Procedure",
    "Equipment / Material",
    "Environment",
    "Management system",
    "Training / Competence",
    "Design / Change",
    "Other"
];

const PRIORITIES = ["Low", "Medium", "High", "Critical"];

// Open -> In Progress -> Pending Approval -> Closed
const ACTION_STATUSES = ["Open", "In Progress", "Pending Approval", "Closed"];


// =====================================================
// EXPECTED FAILURES (bad input, state changed under us)
// =====================================================

class EngineError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function clean(value) {
    return String(value == null ? "" : value).trim();
}

function toId(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function csv(value) {
    return String(value || "")
        .split(",")
        .map(s => Number(s))
        .filter(n => Number.isInteger(n) && n > 0);
}


// =====================================================
// ACTION QUERY (shared by the record page and the dashboard)
// Adds: role name, current owners, their line managers, overdue flag.
// =====================================================

const OWNER_NAMES = `
    (SELECT GROUP_CONCAT(DISTINCT e.employee_name ORDER BY e.employee_name SEPARATOR ', ')
       FROM v_action_owners o JOIN employees e ON e.employee_id = o.employee_id
      WHERE o.action_id = a.action_id)`;

const OWNER_IDS = `
    (SELECT GROUP_CONCAT(DISTINCT o.employee_id)
       FROM v_action_owners o WHERE o.action_id = a.action_id)`;

const APPROVER_NAMES = `
    (SELECT GROUP_CONCAT(DISTINCT lm.employee_name ORDER BY lm.employee_name SEPARATOR ', ')
       FROM v_action_owners o
       JOIN employees e  ON e.employee_id  = o.employee_id
       JOIN employees lm ON lm.employee_id = e.line_manager_id
      WHERE o.action_id = a.action_id)`;

const APPROVER_IDS = `
    (SELECT GROUP_CONCAT(DISTINCT e.line_manager_id)
       FROM v_action_owners o JOIN employees e ON e.employee_id = o.employee_id
      WHERE o.action_id = a.action_id AND e.line_manager_id IS NOT NULL)`;

const ACTION_COLUMNS = `
    a.*,
    ro.role_name                              AS role_name,
    ${OWNER_NAMES}                            AS owner_names,
    ${OWNER_IDS}                              AS owner_ids,
    ${APPROVER_NAMES}                         AS approver_names,
    ${APPROVER_IDS}                           AS approver_ids,
    (a.due_date IS NOT NULL AND a.due_date < CURDATE() AND a.status <> 'Closed') AS overdue`;

const ACTION_FROM = `
    record_actions a
    LEFT JOIN roles ro ON ro.role_id = a.responsible_role_id`;


// What can this user do to this action?
function actionPerms(user, action) {

    const emp = user && user.employee_id ? Number(user.employee_id) : null;
    const admin = isAdmin(user);

    const owners = csv(action.owner_ids);
    const approvers = csv(action.approver_ids);

    const isOwner = emp !== null && owners.includes(emp);
    const isApprover = emp !== null && approvers.includes(emp);

    // No line manager on file for the owner(s): a user with the "Line Manager" role may approve.
    const roleFallback = approvers.length === 0 && roleName(user) === "line manager";

    const completedByMe = ENFORCE_SEGREGATION &&
        action.completed_by && action.completed_by === (user && user.user_id);

    return {
        canWork: (admin || isOwner) &&
            ["Open", "In Progress"].includes(action.status),
        canApprove: action.status === "Pending Approval" &&
            (admin || isApprover || roleFallback) &&
            !completedByMe
    };
}


// =====================================================
// LOAD EVERYTHING FOR ONE RECORD
// =====================================================

async function loadRecordHeader(moduleKey, recordId) {

    const [rows] = await db.query(`
        SELECT module, record_id, title, record_date, location, status
        FROM v_records
        WHERE module = ? AND record_id = ?
    `, [moduleKey, recordId]);

    return rows[0] || null;
}

async function loadPanel(moduleKey, recordId, user) {

    const [findings] = await db.query(`
        SELECT * FROM record_findings
        WHERE module = ? AND record_id = ?
        ORDER BY finding_id
    `, [moduleKey, recordId]);

    const [rootCauses] = await db.query(`
        SELECT rc.*
        FROM record_root_causes rc
        JOIN record_findings f ON f.finding_id = rc.finding_id
        WHERE f.module = ? AND f.record_id = ?
        ORDER BY rc.root_cause_id
    `, [moduleKey, recordId]);

    const [actions] = await db.query(`
        SELECT ${ACTION_COLUMNS}
        FROM ${ACTION_FROM}
        WHERE a.module = ? AND a.record_id = ?
        ORDER BY a.action_id
    `, [moduleKey, recordId]);

    for (const a of actions) {
        Object.assign(a, actionPerms(user, a));
    }

    const rcById = new Map(rootCauses.map(rc => [rc.root_cause_id, rc]));

    for (const f of findings) {
        f.rootCauses = rootCauses.filter(rc => rc.finding_id === f.finding_id);
        f.actions = actions.filter(a => a.finding_id === f.finding_id);
        for (const a of f.actions) {
            a.root_cause_text = a.root_cause_id && rcById.get(a.root_cause_id)
                ? rcById.get(a.root_cause_id).description
                : null;
        }
    }

    const [roles] = await db.query("SELECT role_id, role_name FROM roles ORDER BY role_name");

    const [employees] = await db.query(`
        SELECT employee_id, employee_name, role_id
        FROM employees
        WHERE status = 'Active'
        ORDER BY employee_name
    `);

    return {
        findings,
        generalActions: actions.filter(a => a.finding_id === null),
        roles,
        employees
    };
}


// Everything the findings panel partial needs, in one object.
async function buildPanel(moduleKey, recordId, user, returnTo) {

    const panel = await loadPanel(moduleKey, recordId, user);

    return {
        ...panel,
        moduleKey,
        recordId,
        returnTo,
        canAdd: roleCan(user, moduleKey, "add"),
        admin: isAdmin(user),
        severities: SEVERITIES,
        categories: ROOT_CAUSE_CATEGORIES,
        priorities: PRIORITIES
    };
}


// =====================================================
// FINDING STATUS FOLLOWS ITS ACTIONS
// =====================================================

async function syncFinding(conn, findingId) {

    if (!findingId) return;

    const [rows] = await conn.query(`
        SELECT COUNT(*) AS total, COALESCE(SUM(status = 'Closed'), 0) AS closed
        FROM record_actions
        WHERE finding_id = ?
    `, [findingId]);

    const allClosed = rows[0].total > 0 && Number(rows[0].closed) === rows[0].total;

    await conn.query(`
        UPDATE record_findings
        SET status = ?, closed_at = ${allClosed ? "COALESCE(closed_at, NOW())" : "NULL"}
        WHERE finding_id = ?
    `, [allClosed ? "Closed" : "Open", findingId]);
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


// =====================================================
// CREATE
// =====================================================

async function addFinding(moduleKey, recordId, user, body) {

    const description = clean(body.description);

    if (!description) {
        throw new EngineError("A finding needs a description.");
    }

    const severity = SEVERITIES.includes(body.severity) ? body.severity : "Minor";

    const [result] = await db.query(`
        INSERT INTO record_findings (module, record_id, description, severity, raised_by)
        VALUES (?, ?, ?, ?, ?)
    `, [moduleKey, recordId, description, severity, user.user_id]);

    return result.insertId;
}

async function addRootCause(findingId, user, body) {

    const description = clean(body.description);

    if (!description) {
        throw new EngineError("A root cause needs a description.");
    }

    const category = ROOT_CAUSE_CATEGORIES.includes(body.category) ? body.category : "Other";

    await db.query(`
        INSERT INTO record_root_causes (finding_id, category, description, raised_by)
        VALUES (?, ?, ?, ?)
    `, [findingId, category, description, user.user_id]);
}

// findingId may be null for a general action (e.g. from meeting minutes).
async function addAction(moduleKey, recordId, findingId, user, body) {

    const description = clean(body.description);
    const roleId = toId(body.responsible_role_id);
    const employeeId = toId(body.assigned_employee_id);
    const party = clean(body.action_party);
    const due = clean(body.due_date);

    if (!description) {
        throw new EngineError("An action needs a description.");
    }

    if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
        throw new EngineError("An action needs a due date.");
    }

    if (!roleId && !employeeId) {
        throw new EngineError("Pick the role responsible for the action (or a named person).");
    }

    // Actions are tied to a role. If only a person was picked, use their role
    // so the action still follows the role when that person leaves.
    let effectiveRole = roleId;

    if (!effectiveRole && employeeId) {
        const [emp] = await db.query(
            "SELECT role_id FROM employees WHERE employee_id = ?", [employeeId]
        );
        effectiveRole = emp[0] ? emp[0].role_id : null;
    }

    const rootCauseId = toId(body.root_cause_id);

    await withTransaction(async (conn) => {

        await conn.query(`
            INSERT INTO record_actions
                (finding_id, module, record_id, root_cause_id, description, due_date, priority,
                 action_party, responsible_role_id, assigned_employee_id, raised_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            findingId,
            moduleKey,
            recordId,
            rootCauseId,
            description,
            due,
            PRIORITIES.includes(body.priority) ? body.priority : "Medium",
            party || null,
            effectiveRole,
            employeeId,
            user.user_id
        ]);

        // A new open action re-opens a finding that had been closed.
        await syncFinding(conn, findingId);
    });
}


// =====================================================
// ACTION WORKFLOW
// =====================================================

async function loadAction(actionId, user) {

    const [rows] = await db.query(`
        SELECT ${ACTION_COLUMNS}
        FROM ${ACTION_FROM}
        WHERE a.action_id = ?
    `, [actionId]);

    if (rows.length === 0) {
        throw new EngineError("Action not found.", 404);
    }

    Object.assign(rows[0], actionPerms(user, rows[0]));

    return rows[0];
}

// Owner starts work
async function startAction(actionId, user) {

    const action = await loadAction(actionId, user);

    if (!action.canWork) {
        throw new EngineError("You cannot update this action.", 403);
    }

    await db.query(
        "UPDATE record_actions SET status = 'In Progress' WHERE action_id = ? AND status = 'Open'",
        [actionId]
    );
}

// Owner says it is done -> waits for the line manager
async function submitAction(actionId, user, body, evidencePath) {

    const action = await loadAction(actionId, user);

    if (!action.canWork) {
        throw new EngineError("You cannot update this action.", 403);
    }

    const notes = clean(body.completion_notes);

    if (!notes) {
        throw new EngineError("Describe what was done before submitting the action for approval.");
    }

    await db.query(`
        UPDATE record_actions
        SET status = 'Pending Approval',
            completion_notes = ?,
            evidence_path = COALESCE(?, evidence_path),
            completed_by = ?,
            completed_at = NOW(),
            approval_comments = NULL
        WHERE action_id = ? AND status IN ('Open', 'In Progress')
    `, [notes, evidencePath || null, user.user_id, actionId]);
}

// Line manager approves -> action closes -> finding may close
async function approveAction(actionId, user, body) {

    const action = await loadAction(actionId, user);

    if (!action.canApprove) {
        throw new EngineError(
            "Only the line manager of the person responsible can approve this action " +
            "(and not the person who completed it).", 403
        );
    }

    await withTransaction(async (conn) => {

        const [result] = await conn.query(`
            UPDATE record_actions
            SET status = 'Closed',
                approved_by = ?,
                approved_at = NOW(),
                approval_comments = ?
            WHERE action_id = ? AND status = 'Pending Approval'
        `, [user.user_id, clean(body.comments) || null, actionId]);

        if (result.affectedRows !== 1) {
            throw new EngineError("This action was already updated by someone else.", 409);
        }

        await syncFinding(conn, action.finding_id);
    });
}

// Line manager sends it back
async function rejectAction(actionId, user, body) {

    const action = await loadAction(actionId, user);

    if (!action.canApprove) {
        throw new EngineError("You cannot review this action.", 403);
    }

    const comments = clean(body.comments);

    if (!comments) {
        throw new EngineError("Say what is missing when sending an action back.");
    }

    await db.query(`
        UPDATE record_actions
        SET status = 'In Progress', approval_comments = ?
        WHERE action_id = ? AND status = 'Pending Approval'
    `, [comments, actionId]);
}


// =====================================================
// ADMIN EDIT / DELETE
// =====================================================

async function updateFinding(findingId, body) {

    const description = clean(body.description);

    if (!description) throw new EngineError("A finding needs a description.");

    await db.query(
        "UPDATE record_findings SET description = ?, severity = ? WHERE finding_id = ?",
        [description, SEVERITIES.includes(body.severity) ? body.severity : "Minor", findingId]
    );
}

async function updateAction(actionId, body) {

    const description = clean(body.description);
    const due = clean(body.due_date);
    const roleId = toId(body.responsible_role_id);
    const employeeId = toId(body.assigned_employee_id);

    if (!description || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
        throw new EngineError("Description and a valid due date are required.");
    }

    if (!roleId && !employeeId) {
        throw new EngineError("Pick a responsible role or a named person.");
    }

    await db.query(`
        UPDATE record_actions
        SET description = ?, due_date = ?, priority = ?, action_party = ?,
            responsible_role_id = ?, assigned_employee_id = ?
        WHERE action_id = ?
    `, [
        description, due,
        PRIORITIES.includes(body.priority) ? body.priority : "Medium",
        clean(body.action_party) || null,
        roleId, employeeId, actionId
    ]);
}

async function deleteFinding(findingId) {
    await db.query("DELETE FROM record_findings WHERE finding_id = ?", [findingId]);
}

async function deleteRootCause(rootCauseId) {
    await db.query("DELETE FROM record_root_causes WHERE root_cause_id = ?", [rootCauseId]);
}

async function deleteAction(actionId) {

    await withTransaction(async (conn) => {

        const [rows] = await conn.query(
            "SELECT finding_id FROM record_actions WHERE action_id = ?", [actionId]
        );

        await conn.query("DELETE FROM record_actions WHERE action_id = ?", [actionId]);

        if (rows[0]) await syncFinding(conn, rows[0].finding_id);
    });
}


module.exports = {
    SEVERITIES,
    ROOT_CAUSE_CATEGORIES,
    PRIORITIES,
    ACTION_STATUSES,
    EngineError,
    ACTION_COLUMNS,
    ACTION_FROM,
    clean,
    toId,
    withTransaction,
    actionPerms,
    loadRecordHeader,
    loadPanel,
    buildPanel,
    syncFinding,
    addFinding,
    addRootCause,
    addAction,
    startAction,
    submitAction,
    approveAction,
    rejectAction,
    updateFinding,
    updateAction,
    deleteFinding,
    deleteRootCause,
    deleteAction
};
