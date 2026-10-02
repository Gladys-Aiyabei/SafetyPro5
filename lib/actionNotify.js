// =====================================================
// FINDING / ACTION EMAILS
//
//  * DUE: once an open action reaches its due date, its current owners (v_action_owners)
//    get an email, copied to their line managers. If the owner has already submitted it
//    (Pending Approval), the line managers are asked to approve it instead.
//    Checked on start-up and every hour; each action is notified once per due date
//    (table action_due_notices), so moving the due date gives a fresh notice.
//  * CLOSED: when an action is approved (closed), its owners, the person who completed it
//    and the person who raised it are told. If that closes the finding, the person who
//    raised the finding and the owners of all its actions are told as well.
//
// Never throws: email problems are logged and must not break the workflow.
// =====================================================

const db = require("../db");
const mailer = require("./mailer");

const CHECK_EVERY_MS = 60 * 60 * 1000;

const esc = v => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = d => (d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");

// YYYY-MM-DD of a DATE column, without timezone shifts.
const isoDate = d => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};


// =====================================================
// TABLE (created on first use; the same DDL is in sql/action_notifications.sql)
// =====================================================

let tableReady = null;

function ensureTable() {

    if (!tableReady) {
        tableReady = db.query(`
            CREATE TABLE IF NOT EXISTS action_due_notices (
                action_id  INT        NOT NULL,
                due_date   DATE       NOT NULL,
                sent_at    TIMESTAMP  NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (action_id, due_date),
                CONSTRAINT fk_due_notices_action FOREIGN KEY (action_id)
                    REFERENCES record_actions (action_id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
        ).catch(error => { tableReady = null; throw error; });
    }

    return tableReady;
}


// =====================================================
// LOOKUPS
// =====================================================

const ACTION_SELECT = `
    SELECT a.*, r.title AS record_title,
           f.description AS finding_text, f.raised_by AS finding_raised_by,
           rp.employee_name AS responsible_name, lm.employee_name AS line_manager_name
    FROM record_actions a
    LEFT JOIN employees rp ON rp.employee_id = a.assigned_employee_id
    LEFT JOIN employees lm ON lm.employee_id = a.line_manager_id
    LEFT JOIN v_records r ON r.module = a.module AND r.record_id = a.record_id
    LEFT JOIN record_findings f ON f.finding_id = a.finding_id`;

// Current owners of an action, with the action's line manager
// (older actions without one: the owner's line manager on file).
async function owners(actionId) {

    const [rows] = await db.query(`
        SELECT e.employee_name, e.email, lm.employee_name AS lm_name, lm.email AS lm_email
        FROM v_action_owners o
        JOIN record_actions a ON a.action_id = o.action_id
        JOIN employees e ON e.employee_id = o.employee_id
        LEFT JOIN employees lm ON lm.employee_id = COALESCE(a.line_manager_id, e.line_manager_id)
                              AND lm.status = 'Active'
        WHERE o.action_id = ?
    `, [actionId]);

    return rows;
}

async function appUsers(userIds) {

    const ids = userIds.filter(Boolean);

    if (ids.length === 0) return [];

    const [rows] = await db.query(
        "SELECT user_id, username, email FROM users WHERE user_id IN (?)", [ids]
    );

    return rows;
}

// Collects { email, name, reason }; one entry per address, first (most specific) reason wins.
function recipientList() {

    const list = [];
    const seen = new Set();

    return {
        add(email, name, reason) {
            const e = String(email || "").trim();
            if (!e.includes("@") || seen.has(e.toLowerCase())) return;
            seen.add(e.toLowerCase());
            list.push({ email: e, name, reason });
        },
        list
    };
}


// =====================================================
// MESSAGE
// =====================================================

function buildMessage({ to, subject, intro, ask, rows, url, button }) {

    const text = [
        `Hello ${to.name || ""},`.trim(),
        "",
        `${intro} You are receiving this as ${to.reason}.`,
        ...(ask ? ["", ask] : []),
        "",
        ...rows.map(([k, v]) => `${k}: ${v || "-"}`),
        "",
        `${button}: ${url}`
    ].join("\n");

    const html = `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:620px">
            <p>Hello ${esc(to.name)},</p>
            <p>${esc(intro)} You are receiving this as ${esc(to.reason)}.</p>
            ${ask ? `<p style="background:#fff8e1;border-left:4px solid #ffc107;padding:10px"><strong>${esc(ask)}</strong></p>` : ""}
            <table cellpadding="6" style="border-collapse:collapse;width:100%">
                ${rows.map(([k, v]) => `
                <tr>
                    <td style="border-bottom:1px solid #eee;font-weight:bold;width:150px;vertical-align:top">${esc(k)}</td>
                    <td style="border-bottom:1px solid #eee;white-space:pre-wrap">${esc(v || "-")}</td>
                </tr>`).join("")}
            </table>
            <p style="margin-top:20px">
                <a href="${esc(url)}" style="background:#0d6efd;color:#fff;padding:10px 18px;border-radius:5px;text-decoration:none">
                    ${esc(button)}
                </a>
            </p>
            <p style="color:#777;font-size:12px">If the button does not work, copy this link: ${esc(url)}</p>
        </div>`;

    return { to: to.email, subject, text, html };
}

// Sends one email per recipient; returns how many went out.
async function sendAll(label, people, make) {

    const results = await Promise.allSettled(people.map(p => mailer.send(make(p))));

    results.forEach((r, i) => {
        if (r.status === "rejected") {
            console.error(`${label}: email to ${people[i].email} failed:`, r.reason.message);
        }
    });

    const sent = results.filter(r => r.status === "fulfilled").length;
    console.log(`${label}: notification ${mailer.configured ? "sent" : "logged"} for ${sent} of ${people.length} recipient(s).`);

    return sent;
}

function actionRows(action) {
    return [
        ["Record", action.record_title || `${action.module} #${action.record_id}`],
        ["Finding", action.finding_text || "General action"],
        ["Action", action.description],
        ["Priority", action.priority],
        ["Responsible", action.responsible_name],
        ["Line manager", action.line_manager_name],
        ["Due date", fmt(action.due_date)],
        ["Status", action.status]
    ];
}

const OWNER = "the person responsible";
const LINE_MANAGER = "line manager of the person responsible";

const recordLink = a => mailer.link(`/findings/${a.module}/${a.record_id}`);


// =====================================================
// DUE
// =====================================================

async function notifyDue(action) {

    const today = isoDate(new Date());
    const overdue = isoDate(action.due_date) < today;
    const pending = action.status === "Pending Approval";
    const people = recipientList();
    const team = await owners(action.action_id);

    // Whoever has to act next is added first, so they keep that reason if they are both.
    if (pending) {
        for (const o of team) people.add(o.lm_email, o.lm_name, LINE_MANAGER);
        for (const o of team) people.add(o.email, o.employee_name, OWNER);
    } else {
        for (const o of team) people.add(o.email, o.employee_name, OWNER);
        for (const o of team) people.add(o.lm_email, o.lm_name, LINE_MANAGER);
    }

    // Nobody holds the role (or no emails on file): tell whoever raised the action.
    if (people.list.length === 0) {
        for (const u of await appUsers([action.raised_by])) {
            people.add(u.email, u.username, "the person who raised it (no owner with an email address was found)");
        }
    }

    if (people.list.length === 0) {
        console.log(`Action #${action.action_id} is due but has no one with an email address to notify.`);
        return 0;
    }

    const when = overdue ? `was due on ${fmt(action.due_date)} and is overdue` : "is due today";

    const subject = `Action #${action.action_id} ${overdue ? "overdue" : "due today"}` +
        (pending ? " - awaiting approval" : "") + `: ${String(action.description).slice(0, 80)}`;

    // Only the person who has to act next is asked to do something.
    const askFor = to => {
        if (pending) return to.reason === LINE_MANAGER
            ? "The work has been submitted. As line manager, please review it and approve or send it back."
            : null;
        return to.reason === LINE_MANAGER
            ? null
            : "Please complete the action and submit it for approval, with evidence, using the link below.";
    };

    return sendAll(`Action #${action.action_id} due`, people.list, to => buildMessage({
        to,
        subject,
        intro: `An action in SafetyPro ${when}.`,
        ask: askFor(to),
        rows: actionRows(action),
        url: recordLink(action),
        button: `Open action #${action.action_id}`
    }));
}

let checking = false;

// Finds open actions that have reached their due date and not been notified for that date.
async function checkDueActions() {

    if (checking) return;
    checking = true;

    try {
        await ensureTable();

        const [due] = await db.query(`
            ${ACTION_SELECT}
            LEFT JOIN action_due_notices n ON n.action_id = a.action_id AND n.due_date = a.due_date
            WHERE a.status <> 'Closed'
              AND a.due_date IS NOT NULL
              AND a.due_date <= CURDATE()
              AND n.action_id IS NULL
            ORDER BY a.due_date, a.action_id
        `);

        for (const action of due) {

            try {
                // Claim it first so an overlapping run cannot send it twice.
                const [claim] = await db.query(
                    "INSERT IGNORE INTO action_due_notices (action_id, due_date) VALUES (?, ?)",
                    [action.action_id, action.due_date]
                );

                if (claim.affectedRows !== 1) continue;

                const sent = await notifyDue(action);

                // Every email failed: release the claim so the next check retries.
                if (sent === 0 && mailer.configured) {
                    await db.query(
                        "DELETE FROM action_due_notices WHERE action_id = ? AND due_date = ?",
                        [action.action_id, action.due_date]
                    );
                }
            } catch (error) {
                console.error(`Action #${action.action_id} due notification failed:`, error.message);
            }
        }

    } catch (error) {
        console.error("Due action check failed:", error.message);
    } finally {
        checking = false;
    }
}

function startDueReminders() {
    checkDueActions();
    setInterval(checkDueActions, CHECK_EVERY_MS);
}


// =====================================================
// CLOSED
// =====================================================

// findingClosed: approving this action also closed its finding.
async function notifyActionClosed(actionId, findingClosed) {

    try {
        const [rows] = await db.query(`${ACTION_SELECT} WHERE a.action_id = ?`, [actionId]);

        if (rows.length === 0) return;

        const action = rows[0];
        const users = await appUsers([action.approved_by, action.completed_by, action.raised_by]);
        const byId = id => users.find(u => u.user_id === id);
        const approver = byId(action.approved_by);

        const people = recipientList();

        for (const o of await owners(actionId)) people.add(o.email, o.employee_name, OWNER);

        const completer = byId(action.completed_by);
        if (completer) people.add(completer.email, completer.username, "the person who completed it");

        const raiser = byId(action.raised_by);
        if (raiser) people.add(raiser.email, raiser.username, "the person who raised it");

        const details = [
            ...actionRows(action),
            ["Completion notes", action.completion_notes],
            ["Approved by", approver ? approver.username : null],
            ["Approved on", fmt(action.approved_at)],
            ["Approval comments", action.approval_comments]
        ];

        if (people.list.length) {
            await sendAll(`Action #${actionId} closed`, people.list, to => buildMessage({
                to,
                subject: `Action #${actionId} closed: ${String(action.description).slice(0, 80)}`,
                intro: "An action in SafetyPro has been approved and closed.",
                rows: details,
                url: recordLink(action),
                button: `Open action #${actionId}`
            }));
        }

        if (findingClosed && action.finding_id) await notifyFindingClosed(action.finding_id);

    } catch (error) {
        console.error(`Action #${actionId} closed notification failed:`, error.message);
    }
}

async function notifyFindingClosed(findingId) {

    try {
        const [rows] = await db.query(`
            SELECT f.*, r.title AS record_title,
                   rp.employee_name AS responsible_name, rp.email AS responsible_email,
                   lm.employee_name AS line_manager_name, lm.email AS line_manager_email
            FROM record_findings f
            LEFT JOIN employees rp ON rp.employee_id = f.responsible_employee_id
            LEFT JOIN employees lm ON lm.employee_id = f.line_manager_id
            LEFT JOIN v_records r ON r.module = f.module AND r.record_id = f.record_id
            WHERE f.finding_id = ?
        `, [findingId]);

        if (rows.length === 0) return;

        const finding = rows[0];

        const [actions] = await db.query(
            "SELECT action_id FROM record_actions WHERE finding_id = ? ORDER BY action_id", [findingId]
        );

        const people = recipientList();

        people.add(finding.responsible_email, finding.responsible_name, "the person responsible for the finding");
        people.add(finding.line_manager_email, finding.line_manager_name, "line manager for the finding");

        for (const u of await appUsers([finding.raised_by])) {
            people.add(u.email, u.username, "the person who raised the finding");
        }

        for (const a of actions) {
            for (const o of await owners(a.action_id)) {
                people.add(o.email, o.employee_name, "a person responsible for one of its actions");
            }
        }

        if (people.list.length === 0) return;

        const url = mailer.link(`/findings/${finding.module}/${finding.record_id}`);

        await sendAll(`Finding #${findingId} closed`, people.list, to => buildMessage({
            to,
            subject: `Finding #${findingId} closed: ${String(finding.description).slice(0, 80)}`,
            intro: "A finding in SafetyPro has been closed: all of its actions are complete and approved.",
            rows: [
                ["Record", finding.record_title || `${finding.module} #${finding.record_id}`],
                ["Finding", finding.description],
                ["Severity", finding.severity],
                ["Responsible", finding.responsible_name],
                ["Line manager", finding.line_manager_name],
                ["Raised on", fmt(finding.raised_at)],
                ["Closed on", fmt(finding.closed_at)],
                ["Actions", `${actions.length} action(s), all closed`]
            ],
            url,
            button: `Open finding #${findingId}`
        }));

    } catch (error) {
        console.error(`Finding #${findingId} closed notification failed:`, error.message);
    }
}


module.exports = { startDueReminders, checkDueActions, notifyActionClosed, notifyFindingClosed };
