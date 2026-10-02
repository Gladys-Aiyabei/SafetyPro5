// =====================================================
// NEW INCIDENT EMAIL
// Sent when an incident is added, to:
//   * the line manager of the incident
//   * the user who added it and the employee it was reported by
//   * every employee with the Head of Safety role
//   * every employee with a management role (MANAGEMENT_ROLES)
// Each person gets their own email with a link to the incident.
// =====================================================

const db = require("../db");
const mailer = require("./mailer");

// Employee roles (roles.role_name, any case) treated as the management team.
const MANAGEMENT_ROLES = ["Manager"];

const HEAD_OF_SAFETY_ROLE = "Head of Safety";

const esc = v => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function recipients(incident, user) {

    const list = [];
    const add = (email, name, reason) => {
        if (email && String(email).includes("@")) list.push({ email: String(email).trim(), name, reason });
    };

    const ids = [incident.line_manager_id, incident.reported_by].filter(Boolean);

    if (ids.length) {
        const [people] = await db.query(
            "SELECT employee_id, employee_name, email FROM employees WHERE employee_id IN (?)", [ids]
        );
        for (const p of people) {
            if (p.employee_id === Number(incident.line_manager_id)) add(p.email, p.employee_name, LINE_MANAGER_REASON);
            if (p.employee_id === Number(incident.reported_by)) add(p.email, p.employee_name, "the person who reported it");
        }
    }

    if (user) add(user.email, user.username, "the person who added it");

    const roleNames = [HEAD_OF_SAFETY_ROLE, ...MANAGEMENT_ROLES].map(r => r.toLowerCase());

    const [byRole] = await db.query(`
        SELECT e.employee_name, e.email, r.role_name
        FROM employees e
        JOIN roles r ON r.role_id = e.role_id
        WHERE LOWER(TRIM(r.role_name)) IN (?)
          AND COALESCE(e.status, 'Active') = 'Active'
    `, [roleNames]);

    for (const p of byRole) {
        const hos = p.role_name.trim().toLowerCase() === HEAD_OF_SAFETY_ROLE.toLowerCase();
        add(p.email, p.employee_name, hos ? "Head of Safety" : "a member of the management team");
    }

    // One email per address; keep the first (most specific) reason.
    const seen = new Set();
    return list.filter(r => {
        const key = r.email.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

const LINE_MANAGER_REASON = "the line manager";

const LINE_MANAGER_ASK = "As line manager, please log in with the link below and complete the investigation report: " +
    "classification, injuries, witnesses, findings, actions, learnings and rating.";

function buildMessage(incident, names, to) {

    const url = mailer.link(`/incidents/view/${incident.incident_id}#investigation`);
    const ask = to.reason === LINE_MANAGER_REASON ? LINE_MANAGER_ASK : null;
    const when = new Date(incident.incident_date).toLocaleString();

    const rows = [
        ["Date & time", when],
        ["Type", incident.incident_type],
        ["Severity", incident.severity],
        ["Location", incident.location],
        ["Reported by", names.reported_by],
        ["Line manager", names.line_manager],
        ["Status", incident.status],
        ["Description", incident.description],
        ["Immediate action", incident.immediate_action]
    ];

    const subject = `New incident #${incident.incident_id}` +
        (incident.incident_type ? `: ${incident.incident_type}` : "") +
        (incident.severity ? ` (${incident.severity})` : "") +
        (incident.location ? ` at ${incident.location}` : "");

    const text = [
        `Hello ${to.name || ""},`.trim(),
        "",
        `A new incident has been recorded in SafetyPro. You are receiving this as ${to.reason}.`,
        ...(ask ? ["", ask] : []),
        "",
        ...rows.map(([k, v]) => `${k}: ${v || "-"}`),
        "",
        `Open the incident: ${url}`
    ].join("\n");

    const html = `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:620px">
            <p>Hello ${esc(to.name)},</p>
            <p>A new incident has been recorded in SafetyPro. You are receiving this as ${esc(to.reason)}.</p>
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
                    Open incident #${incident.incident_id}
                </a>
            </p>
            <p style="color:#777;font-size:12px">If the button does not work, copy this link: ${esc(url)}</p>
        </div>`;

    return { to: to.email, subject, text, html };
}

// Never throws: email problems are logged and must not break saving the incident.
async function notifyNewIncident(incidentId, user) {

    try {
        const [rows] = await db.query(`
            SELECT i.*, r.employee_name AS reported_by_name, lm.employee_name AS line_manager_name
            FROM incidents i
            LEFT JOIN employees r ON r.employee_id = i.reported_by
            LEFT JOIN employees lm ON lm.employee_id = i.line_manager_id
            WHERE i.incident_id = ?
        `, [incidentId]);

        if (rows.length === 0) return;

        const incident = rows[0];
        const names = { reported_by: incident.reported_by_name, line_manager: incident.line_manager_name };
        const people = await recipients(incident, user);

        const results = await Promise.allSettled(
            people.map(p => mailer.send(buildMessage(incident, names, p)))
        );

        results.forEach((r, i) => {
            if (r.status === "rejected") {
                console.error(`Incident #${incidentId} email to ${people[i].email} failed:`, r.reason.message);
            }
        });

        const sent = results.filter(r => r.status === "fulfilled").length;
        console.log(`Incident #${incidentId}: notification ${mailer.configured ? "sent" : "logged"} for ${sent} of ${people.length} recipient(s).`);

    } catch (error) {
        console.error(`Incident #${incidentId} notification failed:`, error.message);
    }
}

module.exports = { notifyNewIncident, MANAGEMENT_ROLES };
