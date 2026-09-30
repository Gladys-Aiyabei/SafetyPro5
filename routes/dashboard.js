// =====================================================
// DASHBOARD  (GET /dashboard?sheet=...)
//
// One page, several sheets:
//   overview  incidents  audits  inspections  risks  findings  actions
//   drills    training   employees  ptw
//
// Filters (all optional, kept when switching sheet):
//   module, from, to, year, month, user, department, activity, location
//   (+ status / category on the findings and actions sheets)
//
// Every sheet builds { kpis, charts, tables } and one view draws them.
// Record filters use v_records, so they behave the same in every module.
// =====================================================

const express = require("express");
const router = express.Router();

const db = require("../db");
const { MODULES } = require("../lib/registry");
const { TRAINING_VALIDITY_YEARS, isAdmin, requireAdmin } = require("../lib/access");
const {
    ROLES: USER_ROLES, STATUSES: USER_STATUSES, isActive: isActiveUser, hasRole,
    listUsers, createUser, updateUser, deleteUser
} = require("../lib/users");
const { computeCompliance, planProgress } = require("../lib/compliance");
const { fmtDate } = require("../lib/format");

const SHEETS = [
    { key: "overview", label: "Overview" },
    { key: "incidents", label: "Incidents" },
    { key: "audits", label: "Audits" },
    { key: "inspections", label: "Inspections" },
    { key: "risks", label: "Risk Assessments" },
    { key: "findings", label: "Findings" },
    { key: "actions", label: "Actions" },
    { key: "drills", label: "Emergency Drills" },
    { key: "training", label: "Training" },
    { key: "employees", label: "Employees" },
    { key: "ptw", label: "Permit to Work" },
    { key: "users", label: "Users", adminOnly: true }
];

const USERS_URL = "/dashboard?sheet=users";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];


// =====================================================
// HELPERS
// =====================================================

const sql = async (text, params = []) => (await db.query(text, params))[0];

const moduleLabel = key => (MODULES[key] ? MODULES[key].label : key);

function statusClass(s) {
    return "st-" + String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// A table cell: plain value, or { t: text, href, b: badge-class }
const link = (t, href) => ({ t, href });
const badge = (t, cls) => ({ t, b: cls || statusClass(t) });

function readFilters(req) {

    const q = req.query;
    const num = v => (/^\d+$/.test(String(v || "")) ? Number(v) : null);
    const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : "");

    return {
        module: MODULES[q.module] ? q.module : "",
        from: date(q.from),
        to: date(q.to),
        year: num(q.year),
        month: num(q.month) >= 1 && num(q.month) <= 12 ? num(q.month) : null,
        user: num(q.user),
        department: num(q.department),
        activity: String(q.activity || "").trim().slice(0, 80),
        location: String(q.location || "").trim().slice(0, 100),
        status: String(q.status || "").trim().slice(0, 40),
        category: String(q.category || "").trim().slice(0, 60),
        mine: q.mine === "1"
    };
}

// Record-level filter over v_records (alias r). Returns " AND ..." and params.
function recordFilter(f, r = "r", options = {}) {

    const where = [];
    const params = [];

    if (f.module && !options.skipModule) { where.push(`${r}.module = ?`); params.push(f.module); }
    if (f.from) { where.push(`${r}.record_date >= ?`); params.push(f.from); }
    if (f.to) { where.push(`${r}.record_date <= ?`); params.push(f.to); }
    if (f.year) { where.push(`YEAR(${r}.record_date) = ?`); params.push(f.year); }
    if (f.month) { where.push(`MONTH(${r}.record_date) = ?`); params.push(f.month); }
    if (f.user) { where.push(`${r}.employee_id = ?`); params.push(f.user); }
    if (f.department) { where.push(`${r}.department_id = ?`); params.push(f.department); }
    if (f.activity) { where.push(`${r}.activity LIKE ?`); params.push(`%${f.activity}%`); }
    if (f.location) { where.push(`${r}.location = ?`); params.push(f.location); }

    return { and: where.length ? " AND " + where.join(" AND ") : "", params };
}

// Counts grouped by a label expression -> { labels, values }
function series(rows, labelKey = "label", valueKey = "n") {
    return {
        labels: rows.map(r => (r[labelKey] === null || r[labelKey] === "" ? "(none)" : String(r[labelKey]))),
        values: rows.map(r => Number(r[valueKey]))
    };
}

function chart(title, type, data, extra = {}) {
    return { title, type, ...data, ...extra };
}

const kpi = (label, value, color) => ({ label, value, color: color || "blue" });

// Findings / root cause / action charts for one module (or all)
async function findingCharts(f, moduleKey) {

    const scope = { ...f, module: moduleKey || f.module };
    const rf = recordFilter(scope);

    const findingStatus = await sql(`
        SELECT fi.status AS label, COUNT(*) AS n
        FROM record_findings fi JOIN v_records r ON r.module = fi.module AND r.record_id = fi.record_id
        WHERE 1 = 1 ${rf.and}
        GROUP BY fi.status`, rf.params);

    const actionStatus = await sql(`
        SELECT a.status AS label, COUNT(*) AS n
        FROM record_actions a JOIN v_records r ON r.module = a.module AND r.record_id = a.record_id
        WHERE 1 = 1 ${rf.and}
        GROUP BY a.status`, rf.params);

    const rootCauses = await sql(`
        SELECT rc.category AS label, COUNT(*) AS n
        FROM record_root_causes rc
        JOIN record_findings fi ON fi.finding_id = rc.finding_id
        JOIN v_records r ON r.module = fi.module AND r.record_id = fi.record_id
        WHERE 1 = 1 ${rf.and}
        GROUP BY rc.category ORDER BY n DESC`, rf.params);

    return { findingStatus, actionStatus, rootCauses };
}


// =====================================================
// SHEETS
// =====================================================

// ---------- Overview ----------
async function overviewSheet(f) {

    const rf = recordFilter(f);

    const byModule = await sql(`
        SELECT r.module AS label, COUNT(*) AS n
        FROM v_records r WHERE 1 = 1 ${rf.and}
        GROUP BY r.module ORDER BY n DESC`, rf.params);

    const [fs] = await sql(`
        SELECT COUNT(*) AS total, COALESCE(SUM(fi.status = 'Open'), 0) AS open_n
        FROM record_findings fi JOIN v_records r ON r.module = fi.module AND r.record_id = fi.record_id
        WHERE 1 = 1 ${rf.and}`, rf.params);

    const [as] = await sql(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(a.status <> 'Closed'), 0) AS open_n,
               COALESCE(SUM(a.status = 'Pending Approval'), 0) AS pending_n,
               COALESCE(SUM(a.due_date < CURDATE() AND a.status <> 'Closed'), 0) AS overdue_n
        FROM record_actions a JOIN v_records r ON r.module = a.module AND r.record_id = a.record_id
        WHERE 1 = 1 ${rf.and}`, rf.params);

    const [inc] = await sql(`
        SELECT COUNT(*) AS total, COALESCE(SUM(r.status <> 'Closed'), 0) AS open_n
        FROM v_records r WHERE r.module = 'incidents' ${recordFilter(f, "r", { skipModule: true }).and}`,
        recordFilter(f, "r", { skipModule: true }).params);

    const [drills] = await sql(`
        SELECT COUNT(*) AS total, COALESCE(SUM(r.status = 'Completed'), 0) AS done
        FROM v_records r WHERE r.module = 'drills' ${recordFilter(f, "r", { skipModule: true }).and}`,
        recordFilter(f, "r", { skipModule: true }).params);

    const compliance = await computeCompliance({
        department_id: f.department || undefined, employee_id: f.user || undefined, location: f.location || undefined
    });

    const findingsByModule = await sql(`
        SELECT fi.module AS label, COUNT(*) AS n
        FROM record_findings fi JOIN v_records r ON r.module = fi.module AND r.record_id = fi.record_id
        WHERE 1 = 1 ${rf.and} GROUP BY fi.module ORDER BY n DESC`, rf.params);

    const actionStatus = await sql(`
        SELECT a.status AS label, COUNT(*) AS n
        FROM record_actions a JOIN v_records r ON r.module = a.module AND r.record_id = a.record_id
        WHERE 1 = 1 ${rf.and} GROUP BY a.status`, rf.params);

    const s = compliance.summary;

    return {
        kpis: [
            kpi("Open incidents", inc.open_n, "red"),
            kpi("Open findings", fs.open_n, "red"),
            kpi("Open actions", as.open_n, "yellow"),
            kpi("Awaiting approval", as.pending_n, "blue"),
            kpi("Overdue actions", as.overdue_n, "red"),
            kpi("Drills done", `${drills.done}/${drills.total}`, "green"),
            kpi("Staff fully trained", s.employees ? `${Math.round((s.fully / s.employees) * 100)}%` : "n/a", "green")
        ],
        charts: [
            chart("Records by module", "bar", series(byModule.map(r => ({ ...r, label: moduleLabel(r.label) }))), { horizontal: true }),
            chart("Findings by module", "bar", series(findingsByModule.map(r => ({ ...r, label: moduleLabel(r.label) })))),
            chart("Action status", "doughnut", series(actionStatus))
        ],
        tables: []
    };
}

// ---------- Incidents ----------
async function incidentsSheet(f) {

    const rf = recordFilter(f, "r", { skipModule: true });

    const from = `FROM incidents i JOIN v_records r ON r.module = 'incidents' AND r.record_id = i.incident_id
                  WHERE 1 = 1 ${rf.and}`;

    const overTime = await sql(`SELECT DATE_FORMAT(r.record_date, '%Y-%m') AS label, COUNT(*) AS n ${from}
        GROUP BY label ORDER BY label`, rf.params);

    const byType = await sql(`SELECT i.incident_type AS label, COUNT(*) AS n ${from} GROUP BY label ORDER BY n DESC`, rf.params);
    const bySeverity = await sql(`SELECT i.severity AS label, COUNT(*) AS n ${from} GROUP BY label ORDER BY n DESC`, rf.params);
    const byStatus = await sql(`SELECT i.status AS label, COUNT(*) AS n ${from} GROUP BY label`, rf.params);

    const fc = await findingCharts(f, "incidents");

    const recent = await sql(`
        SELECT i.incident_id, i.incident_date, i.incident_type, i.severity, i.location, i.status,
               (SELECT COUNT(*) FROM record_findings x WHERE x.module = 'incidents' AND x.record_id = i.incident_id) AS findings
        ${from} ORDER BY i.incident_date DESC LIMIT 30`, rf.params);

    const total = byStatus.reduce((a, r) => a + Number(r.n), 0);
    const open = byStatus.filter(r => r.label !== "Closed").reduce((a, r) => a + Number(r.n), 0);

    return {
        kpis: [
            kpi("Incidents", total, "blue"),
            kpi("Not closed", open, "red"),
            kpi("High / critical", bySeverity.filter(r => ["High", "Critical"].includes(r.label)).reduce((a, r) => a + Number(r.n), 0), "red"),
            kpi("Open findings", fc.findingStatus.filter(r => r.label === "Open").reduce((a, r) => a + Number(r.n), 0), "yellow")
        ],
        charts: [
            chart("Number of incidents over time", "line", series(overTime), { wide: true }),
            chart("Incident classification (type)", "bar", series(byType)),
            chart("Incident severity", "doughnut", series(bySeverity)),
            chart("Incident root causes", "bar", series(fc.rootCauses), { empty: "No root causes recorded yet" })
        ],
        tables: [{
            title: "Recent incidents",
            columns: ["Date", "Type", "Severity", "Location", "Status", "Findings", ""],
            rows: recent.map(r => [
                fmtDate(r.incident_date), r.incident_type || "-", r.severity || "-", r.location || "-",
                badge(r.status), r.findings,
                link("Findings", `/findings/incidents/${r.incident_id}`)
            ])
        }]
    };
}

// ---------- Audits and inspections (same layout) ----------
async function auditLikeSheet(f, key, typeColumn, label) {

    const mod = MODULES[key];
    const rf = recordFilter(f, "r", { skipModule: true });

    const from = `FROM ${mod.table} t JOIN v_records r ON r.module = '${key}' AND r.record_id = t.${mod.pk}
                  WHERE 1 = 1 ${rf.and}`;

    const byType = await sql(`SELECT t.${typeColumn} AS label, COUNT(*) AS n ${from} GROUP BY label ORDER BY n DESC`, rf.params);
    const byStatus = await sql(`SELECT t.status AS label, COUNT(*) AS n ${from} GROUP BY label`, rf.params);

    const fc = await findingCharts(f, key);

    const checklist = await sql(`
        SELECT cr.result AS label, COUNT(*) AS n
        FROM checklist_responses cr JOIN v_records r ON r.module = cr.module AND r.record_id = cr.record_id
        WHERE cr.module = ? ${rf.and} GROUP BY cr.result`, [key, ...rf.params]);

    const recent = await sql(`
        SELECT t.${mod.pk} AS id, r.record_date, t.${typeColumn} AS kind, r.location, t.status,
               (SELECT COUNT(*) FROM record_findings x WHERE x.module = '${key}' AND x.record_id = t.${mod.pk}) AS findings,
               (SELECT COUNT(*) FROM record_actions x WHERE x.module = '${key}' AND x.record_id = t.${mod.pk} AND x.status <> 'Closed') AS open_actions
        ${from} ORDER BY r.record_date DESC LIMIT 30`, rf.params);

    const count = (rows, ...labels) => rows.filter(r => labels.includes(r.label)).reduce((a, r) => a + Number(r.n), 0);

    return {
        kpis: [
            kpi(label, byStatus.reduce((a, r) => a + Number(r.n), 0), "blue"),
            kpi("Open findings", count(fc.findingStatus, "Open"), "red"),
            kpi("Closed findings", count(fc.findingStatus, "Closed"), "green"),
            kpi("Open actions", fc.actionStatus.filter(r => r.label !== "Closed").reduce((a, r) => a + Number(r.n), 0), "yellow"),
            kpi("Non-compliant checklist answers", count(checklist, "Non-compliant"), "red")
        ],
        charts: [
            chart(`${label} types`, "bar", series(byType)),
            chart("Action status", "doughnut", series(fc.actionStatus), { empty: "No actions yet" }),
            chart("Finding status", "doughnut", series(fc.findingStatus), { empty: "No findings yet" }),
            chart("Root causes", "bar", series(fc.rootCauses), { empty: "No root causes recorded yet" }),
            chart("Checklist results", "doughnut", series(checklist), { empty: "No checklists completed yet" })
        ],
        tables: [{
            title: `Recent ${label.toLowerCase()}`,
            columns: ["Date", "Type", "Location", "Status", "Findings", "Open actions", ""],
            rows: recent.map(r => [
                fmtDate(r.record_date), r.kind || "-", r.location || "-", badge(r.status),
                r.findings, r.open_actions, link("Findings & checklist", `/findings/${key}/${r.id}`)
            ])
        }]
    };
}

// ---------- Risk assessments ----------
async function risksSheet(f) {

    const rf = recordFilter(f, "r", { skipModule: true });

    const rows = await sql(`
        SELECT k.risk_id, k.activity, k.hazard, k.risk_score, k.risk_level, r.location, r.record_date,
               (SELECT e.employee_name FROM employees e WHERE e.employee_id = k.responsible_person) AS owner,
               (SELECT COUNT(*) FROM record_actions a WHERE a.module = 'risks' AND a.record_id = k.risk_id AND a.status <> 'Closed') AS open_actions,
               (SELECT COUNT(*) FROM record_actions a WHERE a.module = 'risks' AND a.record_id = k.risk_id AND a.status <> 'Closed' AND a.due_date < CURDATE()) AS overdue_actions,
               (SELECT MIN(a.due_date) FROM record_actions a WHERE a.module = 'risks' AND a.record_id = k.risk_id AND a.status <> 'Closed') AS next_due
        FROM risk_assessments k JOIN v_records r ON r.module = 'risks' AND r.record_id = k.risk_id
        WHERE 1 = 1 ${rf.and}
        ORDER BY k.risk_score DESC, k.risk_id`, rf.params);

    const levels = ["Critical", "High", "Medium", "Low"];
    const byLevel = levels.map(l => ({ label: l, n: rows.filter(r => r.risk_level === l).length }));

    const byActivity = {};
    rows.forEach(r => { byActivity[r.activity] = (byActivity[r.activity] || 0) + 1; });

    return {
        kpis: [
            kpi("Risks on register", rows.length, "blue"),
            kpi("Critical / high", rows.filter(r => ["Critical", "High"].includes(r.risk_level)).length, "red"),
            kpi("With open actions", rows.filter(r => r.open_actions > 0).length, "yellow"),
            kpi("Overdue actions", rows.reduce((a, r) => a + Number(r.overdue_actions), 0), "red")
        ],
        charts: [
            chart("Risk rating", "doughnut", series(byLevel)),
            chart("Risks by activity", "bar", series(Object.entries(byActivity).map(([label, n]) => ({ label, n }))))
        ],
        tables: [{
            title: "Register of risks",
            columns: ["Activity", "Hazard", "Score", "Rating", "Location", "Owner", "Open actions", "Next action due", ""],
            rows: rows.map(r => [
                r.activity, r.hazard || "-", r.risk_score, badge(r.risk_level, "prio-" + String(r.risk_level || "").toLowerCase()),
                r.location || "-", r.owner || "-",
                r.open_actions > 0 ? badge(`${r.open_actions} open${r.overdue_actions ? `, ${r.overdue_actions} overdue` : ""}`, r.overdue_actions ? "st-overdue" : "st-in-progress") : "None",
                fmtDate(r.next_due) || "-", link("Findings", `/findings/risks/${r.risk_id}`)
            ])
        }]
    };
}

// ---------- Findings ----------
async function findingsSheet(f) {

    const rf = recordFilter(f);
    const where = [rf.and];
    const params = [...rf.params];

    if (f.status) { where.push(" AND fi.status = ?"); params.push(f.status); }

    if (f.category) {
        where.push(" AND EXISTS (SELECT 1 FROM record_root_causes rc WHERE rc.finding_id = fi.finding_id AND rc.category = ?)");
        params.push(f.category);
    }

    const base = `FROM record_findings fi JOIN v_records r ON r.module = fi.module AND r.record_id = fi.record_id
                  WHERE 1 = 1 ${where.join("")}`;

    const byModule = await sql(`SELECT fi.module AS label, COUNT(*) AS n ${base} GROUP BY fi.module ORDER BY n DESC`, params);
    const byStatus = await sql(`SELECT fi.status AS label, COUNT(*) AS n ${base} GROUP BY fi.status`, params);
    const bySeverity = await sql(`SELECT fi.severity AS label, COUNT(*) AS n ${base} GROUP BY fi.severity`, params);

    const causes = await sql(`
        SELECT rc.category AS label, COUNT(*) AS n
        FROM record_root_causes rc JOIN record_findings fi ON fi.finding_id = rc.finding_id
        JOIN v_records r ON r.module = fi.module AND r.record_id = fi.record_id
        WHERE 1 = 1 ${where.join("")} GROUP BY rc.category ORDER BY n DESC`, params);

    const list = await sql(`
        SELECT fi.finding_id, fi.module, fi.record_id, fi.description, fi.severity, fi.status, r.title, r.location,
               (SELECT GROUP_CONCAT(DISTINCT rc.category SEPARATOR ', ') FROM record_root_causes rc WHERE rc.finding_id = fi.finding_id) AS causes,
               (SELECT COUNT(*) FROM record_actions a WHERE a.finding_id = fi.finding_id) AS actions,
               (SELECT COUNT(*) FROM record_actions a WHERE a.finding_id = fi.finding_id AND a.status = 'Closed') AS closed_actions
        ${base} ORDER BY fi.status, fi.finding_id DESC LIMIT 300`, params);

    const n = label => byStatus.filter(r => r.label === label).reduce((a, r) => a + Number(r.n), 0);

    return {
        kpis: [
            kpi("Findings", n("Open") + n("Closed"), "blue"),
            kpi("Open", n("Open"), "red"),
            kpi("Closed", n("Closed"), "green")
        ],
        charts: [
            chart("Findings per module", "bar", series(byModule.map(r => ({ ...r, label: moduleLabel(r.label) })))),
            chart("Findings by status", "doughnut", series(byStatus)),
            chart("Findings by root cause", "bar", series(causes), { empty: "No root causes recorded yet" }),
            chart("Findings by severity", "doughnut", series(bySeverity))
        ],
        tables: [{
            title: `All findings (${list.length}${list.length === 300 ? "+, showing first 300" : ""})`,
            columns: ["Module", "Record", "Finding", "Severity", "Status", "Root causes", "Actions closed", ""],
            rows: list.map(r => [
                moduleLabel(r.module), r.title, r.description.length > 140 ? r.description.slice(0, 140) + "..." : r.description,
                badge(r.severity, "sev-" + String(r.severity).toLowerCase()), badge(r.status),
                r.causes || "-", `${r.closed_actions}/${r.actions}`,
                link("Open", `/findings/${r.module}/${r.record_id}`)
            ])
        }]
    };
}

// ---------- Actions ----------
async function actionsSheet(f, user) {

    const rf = recordFilter(f);
    const where = [rf.and];
    const params = [...rf.params];

    if (f.status) { where.push(" AND a.status = ?"); params.push(f.status); }

    if (f.category) {
        where.push(` AND COALESCE(rc.category, (SELECT MIN(x.category) FROM record_root_causes x WHERE x.finding_id = a.finding_id), 'Not linked') = ?`);
        params.push(f.category);
    }

    if (f.mine) {
        where.push(" AND EXISTS (SELECT 1 FROM v_action_owners o WHERE o.action_id = a.action_id AND o.employee_id = ?)");
        params.push(user.employee_id || 0);
    }

    const base = `FROM record_actions a
                  JOIN v_records r ON r.module = a.module AND r.record_id = a.record_id
                  LEFT JOIN record_root_causes rc ON rc.root_cause_id = a.root_cause_id
                  WHERE 1 = 1 ${where.join("")}`;

    const category = `COALESCE(rc.category, (SELECT MIN(x.category) FROM record_root_causes x WHERE x.finding_id = a.finding_id), 'Not linked')`;

    const byModule = await sql(`SELECT a.module AS label, COUNT(*) AS n ${base} GROUP BY a.module ORDER BY n DESC`, params);
    const byStatus = await sql(`SELECT a.status AS label, COUNT(*) AS n ${base} GROUP BY a.status`, params);
    const byCause = await sql(`SELECT ${category} AS label, COUNT(*) AS n ${base} GROUP BY label ORDER BY n DESC`, params);

    const [totals] = await sql(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(a.status <> 'Closed'), 0) AS open_n,
               COALESCE(SUM(a.status = 'Pending Approval'), 0) AS pending_n,
               COALESCE(SUM(a.due_date < CURDATE() AND a.status <> 'Closed'), 0) AS overdue_n
        ${base}`, params);

    const list = await sql(`
        SELECT a.action_id, a.module, a.record_id, a.description, a.due_date, a.status, a.priority, r.title,
               ${category} AS category, ro.role_name,
               (SELECT GROUP_CONCAT(DISTINCT e.employee_name SEPARATOR ', ')
                  FROM v_action_owners o JOIN employees e ON e.employee_id = o.employee_id
                 WHERE o.action_id = a.action_id) AS owners,
               (a.due_date < CURDATE() AND a.status <> 'Closed') AS overdue
        ${base.replace("WHERE 1 = 1", "LEFT JOIN roles ro ON ro.role_id = a.responsible_role_id WHERE 1 = 1")}
        ORDER BY (a.status = 'Closed'), a.due_date LIMIT 300`, params);

    return {
        kpis: [
            kpi(f.mine ? "My actions" : "Actions", totals.total, "blue"),
            kpi("Open", totals.open_n, "yellow"),
            kpi("Awaiting approval", totals.pending_n, "blue"),
            kpi("Overdue", totals.overdue_n, "red"),
            kpi("Closed", totals.total - totals.open_n, "green")
        ],
        charts: [
            chart("Actions per module", "bar", series(byModule.map(r => ({ ...r, label: moduleLabel(r.label) })))),
            chart("Actions by status", "doughnut", series(byStatus)),
            chart("Actions by root cause", "bar", series(byCause))
        ],
        tables: [{
            title: `${f.mine ? "My" : "All"} actions (${list.length}${list.length === 300 ? "+, showing first 300" : ""})`,
            columns: ["Module", "Record", "Action", "Root cause", "Due", "Responsible now", "Status", ""],
            rows: list.map(r => [
                moduleLabel(r.module), r.title,
                r.description.length > 120 ? r.description.slice(0, 120) + "..." : r.description,
                r.category,
                r.overdue ? badge(fmtDate(r.due_date) + " (overdue)", "st-overdue") : fmtDate(r.due_date),
                `${r.role_name || "-"}${r.owners ? ": " + r.owners : ""}`,
                badge(r.status),
                link("Open", `/findings/${r.module}/${r.record_id}`)
            ])
        }]
    };
}

// ---------- Emergency drills ----------
async function drillsSheet(f) {

    const rf = recordFilter(f, "r", { skipModule: true });

    const drills = await sql(`
        SELECT d.*, r.location AS loc,
               (SELECT e.employee_name FROM employees e WHERE e.employee_id = d.coordinator_id) AS coordinator,
               (d.status = 'Planned' AND d.planned_date < CURDATE()) AS overdue,
               (SELECT COUNT(*) FROM record_actions a WHERE a.module = 'drills' AND a.record_id = d.drill_id) AS actions,
               (SELECT COUNT(*) FROM record_actions a WHERE a.module = 'drills' AND a.record_id = d.drill_id AND a.status <> 'Closed') AS open_actions
        FROM erp_drills d JOIN v_records r ON r.module = 'drills' AND r.record_id = d.drill_id
        WHERE 1 = 1 ${rf.and}
        ORDER BY d.planned_date`, rf.params);

    const planned = Array(12).fill(0);
    const done = Array(12).fill(0);

    drills.forEach(d => {
        const m = new Date(d.planned_date).getMonth();
        planned[m]++;
        if (d.status === "Completed") done[m]++;
    });

    const byType = {};
    drills.forEach(d => { byType[d.drill_type] = (byType[d.drill_type] || 0) + 1; });

    const fc = await findingCharts(f, "drills");

    const doneCount = drills.filter(d => d.status === "Completed").length;
    const counted = drills.filter(d => d.status !== "Cancelled").length;

    return {
        kpis: [
            kpi("Drills scheduled", drills.length, "blue"),
            kpi("Drills done", doneCount, "green"),
            kpi("Overdue", drills.filter(d => d.overdue).length, "red"),
            kpi("Plan completion", counted ? `${Math.round((doneCount / counted) * 100)}%` : "n/a", "yellow"),
            kpi("Open actions", fc.actionStatus.filter(r => r.label !== "Closed").reduce((a, r) => a + Number(r.n), 0), "red")
        ],
        charts: [
            chart("Drill schedule: planned vs done", "bar", {
                labels: MONTH_NAMES,
                datasets: [
                    { label: "Planned", values: planned, color: "#1F5FBF" },
                    { label: "Done", values: done, color: "#29AB87" }
                ]
            }, { wide: true }),
            chart("Drills by type", "bar", series(Object.entries(byType).map(([label, n]) => ({ label, n })))),
            chart("Actions from drills", "doughnut", series(fc.actionStatus), { empty: "No actions yet" })
        ],
        tables: [{
            title: "Drill schedule",
            columns: ["Planned", "Drill", "Type", "Location", "Coordinator", "Status", "Done on", "Actions open/total", ""],
            rows: drills.map(d => [
                fmtDate(d.planned_date), d.title, d.drill_type, d.loc || "-", d.coordinator || "-",
                d.overdue ? badge("Overdue", "st-overdue") : badge(d.status), fmtDate(d.actual_date) || "-",
                `${d.open_actions}/${d.actions}`, link("Open", `/erp/view/${d.drill_id}`)
            ])
        }]
    };
}

// ---------- Training ----------
async function trainingSheet(f) {

    const year = f.year || new Date().getFullYear();

    const compliance = await computeCompliance({
        department_id: f.department || undefined,
        employee_id: f.user || undefined,
        location: f.location || undefined
    });

    const plans = await planProgress(year);

    const [pending] = await sql("SELECT COUNT(*) AS n FROM training WHERE endorsed_at IS NULL");

    const gapByTraining = {};
    compliance.rows.forEach(r => r.items.filter(i => i.status !== "Valid").forEach(i => {
        gapByTraining[i.training] = (gapByTraining[i.training] || 0) + 1;
    }));

    const planStatus = {};
    plans.forEach(p => { planStatus[p.implementation] = (planStatus[p.implementation] || 0) + 1; });

    const s = compliance.summary;

    return {
        kpis: [
            kpi("Staff assessed", s.employees, "blue"),
            kpi("Fully trained", s.fully, "green"),
            kpi("With gaps", s.gaps, "red"),
            kpi("Awaiting endorsement", pending.n, "yellow"),
            kpi(`Plan ${year}: completed`, plans.filter(p => p.implementation === "Completed").length + "/" + plans.length, "green")
        ],
        charts: [
            chart("Staff: fully trained vs gap", "doughnut", series([
                { label: "Fully trained", n: s.fully }, { label: "Gap", n: s.gaps }, { label: "No requirements", n: s.noRequirements }
            ])),
            chart(`Training plan ${year}: implementation`, "doughnut",
                series(Object.entries(planStatus).map(([label, n]) => ({ label, n }))), { empty: "No plan for this year" }),
            chart("Gaps by training", "bar", series(Object.entries(gapByTraining).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n)), { empty: "No gaps" })
        ],
        tables: [
            {
                title: `Training schedule ${year} and implementation`,
                columns: ["Month", "Training", "Role", "Trained / required", "Progress", "Status"],
                rows: plans.map(p => [
                    MONTH_NAMES[(p.target_month || 1) - 1], p.training_name, p.role_name || "-",
                    `${p.trained}/${p.required}`, `${p.pct}%`, badge(p.implementation)
                ])
            },
            {
                title: "Gaps per employee",
                columns: ["Employee", "Role", "Department", "Result", "Missing / not valid"],
                rows: compliance.rows
                    .filter(r => r.overall !== "No requirements")
                    .sort((a, b) => b.gapCount - a.gapCount)
                    .map(r => [
                        r.employee_name, r.role_name, r.department_name || "-",
                        r.overall === "Gap" ? badge(`${r.gapCount} gap${r.gapCount === 1 ? "" : "s"}`, "st-rejected") : badge("Fully trained", "st-valid"),
                        r.items.filter(i => i.status !== "Valid").map(i => `${i.training} (${i.status})`).join("; ") || "-"
                    ])
            }
        ],
        linkLabel: "Open training module"
    };
}

// ---------- Employees / users ----------
async function employeesSheet(f) {

    const where = [];
    const params = [];

    if (f.department) { where.push("e.department_id = ?"); params.push(f.department); }
    if (f.user) { where.push("e.employee_id = ?"); params.push(f.user); }
    if (f.status) { where.push("e.status = ?"); params.push(f.status); }
    if (f.location) {
        where.push("(SELECT d.location FROM departments d WHERE d.department_id = e.department_id LIMIT 1) = ?");
        params.push(f.location);
    }

    const rows = await sql(`
        SELECT e.employee_id, e.employee_name, e.job_title, e.status, e.employment_date, e.email, e.phone,
               d.department_name, d.location, ro.role_name, lm.employee_name AS line_manager,
               (SELECT GROUP_CONCAT(u.role SEPARATOR ', ') FROM users u WHERE u.employee_id = e.employee_id) AS user_role
        FROM employees e
        LEFT JOIN departments d ON d.department_id = e.department_id
        LEFT JOIN roles ro ON ro.role_id = e.role_id
        LEFT JOIN employees lm ON lm.employee_id = e.line_manager_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY e.employee_name`, params);

    const tally = key => {
        const t = {};
        rows.forEach(r => { const k = r[key] || "(none)"; t[k] = (t[k] || 0) + 1; });
        return Object.entries(t).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
    };

    return {
        kpis: [
            kpi("Employees", rows.length, "blue"),
            kpi("Active", rows.filter(r => r.status === "Active").length, "green"),
            kpi("With a user account", rows.filter(r => r.user_role).length, "yellow"),
            kpi("No role assigned", rows.filter(r => !r.role_name).length, "red")
        ],
        charts: [
            chart("By status", "doughnut", series(tally("status"))),
            chart("By department", "bar", series(tally("department_name"))),
            chart("By role", "bar", series(tally("role_name")))
        ],
        tables: [{
            title: "Employees and users",
            columns: ["Employee", "Job title", "Department", "Location", "Role", "Status", "Line manager", "User account role", "Employed"],
            rows: rows.map(r => [
                link(r.employee_name, `/employees/view/${r.employee_id}`), r.job_title || "-", r.department_name || "-",
                r.location || "-", r.role_name || "-", badge(r.status || "-"), r.line_manager || "-",
                r.user_role || "-", fmtDate(r.employment_date) || "-"
            ])
        }]
    };
}

// ---------- Permit to work ----------
async function ptwSheet(f) {

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const issuers = await sql(`
        SELECT u.user_id, u.username, u.employee_id, e.employee_name, d.department_name
        FROM users u
        LEFT JOIN employees e ON e.employee_id = u.employee_id
        LEFT JOIN departments d ON d.department_id = e.department_id
        WHERE LOWER(TRIM(u.role)) = 'permit issuer'
        ${f.department ? "AND e.department_id = " + Number(f.department) : ""}
        ORDER BY e.employee_name, u.username`);

    const trainings = await sql(`
        SELECT t.employee_id, t.training_name, t.training_date, t.expiry_date, t.endorsed_at
        FROM training t
        WHERE (LOWER(t.training_name) LIKE '%permit to work%' OR LOWER(t.training_name) LIKE '%ptw%'
               OR LOWER(t.training_name) LIKE '%permit issuer%')
        ORDER BY t.training_date DESC`);

    const expiryOf = t => {
        const byAge = new Date(t.training_date);
        byAge.setFullYear(byAge.getFullYear() + TRAINING_VALIDITY_YEARS);
        return t.expiry_date && new Date(t.expiry_date) < byAge ? new Date(t.expiry_date) : byAge;
    };

    const statusOf = t => {
        if (!t) return "No training";
        if (!t.endorsed_at) return "Pending endorsement";
        const days = Math.floor((expiryOf(t) - today) / 86400000);
        return days < 0 ? "Expired" : days <= 60 ? "Due soon" : "Valid";
    };

    const rows = issuers.map(u => {
        const mine = trainings.filter(t => t.employee_id === u.employee_id);
        const latest = mine.find(t => t.endorsed_at) || mine[0];
        return { ...u, latest, status: statusOf(latest) };
    });

    const rf = recordFilter(f, "r", { skipModule: true });

    const permitBase = `FROM permits p JOIN v_records r ON r.module = 'permits' AND r.record_id = p.permit_id
                        WHERE 1 = 1 ${rf.and}`;

    const byStatus = await sql(`SELECT p.status AS label, COUNT(*) AS n ${permitBase} GROUP BY label ORDER BY n DESC`, rf.params);
    const byType = await sql(`SELECT p.permit_type AS label, COUNT(*) AS n ${permitBase} GROUP BY label ORDER BY n DESC`, rf.params);
    const [totals] = await sql(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(p.status IN ('Active', 'Approved')), 0) AS active_n,
               COALESCE(SUM(p.expiry_date < NOW() AND p.status <> 'Closed'), 0) AS lapsed_n
        ${permitBase}`, rf.params);

    const trainingStatus = {};
    rows.forEach(r => { trainingStatus[r.status] = (trainingStatus[r.status] || 0) + 1; });

    const chip = s => badge(s, s === "Valid" ? "st-valid" : s === "Due soon" ? "st-in-progress" : s === "Pending endorsement" ? "st-pending" : "st-expired");

    return {
        kpis: [
            kpi("Permit issuers", rows.length, "blue"),
            kpi("Training valid", rows.filter(r => r.status === "Valid").length, "green"),
            kpi("Due soon / expired / none", rows.filter(r => r.status !== "Valid" && r.status !== "Pending endorsement").length, "red"),
            kpi("Permits", totals.total, "blue"),
            kpi("Active", totals.active_n, "green"),
            kpi("Expired, not closed", totals.lapsed_n, "red")
        ],
        charts: [
            chart("Issuer training status", "doughnut", series(Object.entries(trainingStatus).map(([label, n]) => ({ label, n })))),
            chart("Permits by status", "doughnut", series(byStatus)),
            chart("Permits by type", "bar", series(byType))
        ],
        tables: [
            {
                title: `PTW trainings per permit issuer (valid for ${TRAINING_VALIDITY_YEARS} years)`,
                columns: ["Issuer", "User", "Department", "Last PTW training", "Expires", "Status"],
                rows: rows.map(r => [
                    r.employee_name || "(no employee linked)", r.username, r.department_name || "-",
                    r.latest ? fmtDate(r.latest.training_date) : "-",
                    r.latest ? fmtDate(expiryOf(r.latest)) : "-", chip(r.status)
                ])
            }
        ]
    };
}


// =====================================================
// USERS SHEET (Admin only): list, add, edit, delete
// The rules live in lib/users.js (shared with the Users module at /users).
// =====================================================

async function usersSheet(user, editId) {

    const users = await listUsers();

    return {
        kpis: [
            kpi("Users", users.length, "blue"),
            kpi("Active", users.filter(isActiveUser).length, "green"),
            kpi("Inactive", users.filter(u => !isActiveUser(u)).length, "yellow"),
            kpi("Admins", users.filter(u => hasRole(u, "admin")).length, "red")
        ],
        users,
        editUser: editId ? users.find(u => u.user_id === editId) || null : null,
        roles: USER_ROLES,
        statuses: USER_STATUSES,
        meId: user.user_id
    };
}

// Flash a message, then go back to the sheet (or straight to the edit form).
// `form` keeps what the admin typed so a rejected form does not lose it.
function usersFlash(req, res, result, to = USERS_URL) {
    req.session.flash = { type: result.ok ? "ok" : "error", text: result.message, form: result.ok ? null : result.form || null };
    req.session.save(() => res.redirect(to));
}

router.post("/users/add", requireAdmin, async (req, res) => {
    usersFlash(req, res, await createUser(req.body));
});

router.post("/users/:id/edit", requireAdmin, async (req, res) => {

    const id = Number(req.params.id);
    const result = await updateUser(id, req.body, req.session.user);

    usersFlash(req, res, result, result.ok || result.missing ? USERS_URL : `${USERS_URL}&edit=${id}`);
});

router.post("/users/:id/delete", requireAdmin, async (req, res) => {
    usersFlash(req, res, await deleteUser(Number(req.params.id), req.session.user));
});


// =====================================================
// ROUTE
// =====================================================
router.get("/", async (req, res, next) => {

    try {

        const f = readFilters(req);
        const user = req.session.user;

        const wanted = SHEETS.find(s => s.key === req.query.sheet);

        // Admin-only sheets are hidden from everyone else, and refused if asked for directly.
        if (wanted && wanted.adminOnly && !isAdmin(user)) return requireAdmin(req, res, next);

        const sheet = wanted ? wanted.key : "overview";

        const editId = /^\d+$/.test(String(req.query.edit || "")) ? Number(req.query.edit) : null;

        let flash = null;
        if (sheet === "users") {
            flash = req.session.flash || null;
            delete req.session.flash;
        }

        const builders = {
            overview: () => overviewSheet(f),
            incidents: () => incidentsSheet(f),
            audits: () => auditLikeSheet(f, "audits", "audit_type", "Audits"),
            inspections: () => auditLikeSheet(f, "inspections", "inspection_type", "Inspections"),
            risks: () => risksSheet(f),
            findings: () => findingsSheet(f),
            actions: () => actionsSheet(f, user),
            drills: () => drillsSheet(f),
            training: () => trainingSheet(f),
            employees: () => employeesSheet(f),
            ptw: () => ptwSheet(f),
            users: () => usersSheet(user, editId)
        };

        const data = await builders[sheet]();

        const [departments, employees, locations, activities, years, categories] = await Promise.all([
            sql("SELECT department_id, department_name FROM departments ORDER BY department_name"),
            sql("SELECT employee_id, employee_name FROM employees ORDER BY employee_name"),
            sql("SELECT DISTINCT location FROM v_records WHERE location IS NOT NULL AND location <> '' ORDER BY location"),
            sql("SELECT DISTINCT activity FROM v_records WHERE activity IS NOT NULL AND activity <> '' ORDER BY activity LIMIT 200"),
            sql("SELECT DISTINCT YEAR(record_date) AS y FROM v_records WHERE record_date IS NOT NULL ORDER BY y DESC"),
            sql("SELECT DISTINCT category FROM record_root_causes ORDER BY category")
        ]);

        res.render("dashboard", {
            title: "Dashboard",
            sheets: SHEETS.filter(s => !s.adminOnly || isAdmin(user)),
            sheet,
            data,
            flash,
            f,
            departments,
            employees,
            locations: locations.map(l => l.location),
            activities: activities.map(a => a.activity),
            years: years.map(y => y.y).filter(Boolean),
            categories: categories.map(c => c.category),
            modules: Object.keys(MODULES).filter(k => MODULES[k].findings).map(k => ({ key: k, label: MODULES[k].label })),
            monthNames: MONTH_NAMES,
            admin: isAdmin(user),
            hasEmployee: !!user.employee_id
        });

    } catch (error) {
        console.error("Dashboard error:", error);
        res.status(500).send(`Error building the dashboard: ${error.sqlMessage || error.message}`);
    }
});


module.exports = router;
