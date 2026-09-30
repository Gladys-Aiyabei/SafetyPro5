// =====================================================
// MODULE TOOLS (the same for every module)
// Mounted at /tools in app.js
//
//   GET  /tools/:module/summary          record summary charts
//   GET  /tools/:module/report.:fmt      report as xlsx / docx / pdf
//   GET  /tools/:module/upload           bulk-upload page
//   GET  /tools/:module/template.xlsx    upload template
//   POST /tools/:module/upload           bulk upload from Excel / CSV / Word
// =====================================================

const express = require("express");
const router = express.Router();

const db = require("../db");
const { MODULES, displayExpr, reportColumns, applyLocation } = require("../lib/registry");
const { canAddNow } = require("../lib/access");
const { memoryUpload, handleUpload } = require("../lib/uploads");
const { fmtDate, fmtDateTime } = require("../lib/format");
const {
    parseUpload, mapHeaders, buildXlsx, buildDocx, buildPdf
} = require("../lib/tabular");


// =====================================================
// HELPERS
// =====================================================

function moduleFor(req, res) {

    const mod = MODULES[req.params.module];

    if (!mod) {
        res.status(404).send("Unknown module");
        return null;
    }

    return mod;
}

// "WHERE" pieces shared by reports and summaries: location and date range.
function scope(mod, req, alias = "t") {

    const where = [];
    const params = [];

    const location = String(req.query.location || "").trim();

    if (location) {
        where.push(`${mod.loc(alias)} = ?`);
        params.push(location);
    }

    if (mod.dateCol) {

        const from = String(req.query.from || "").trim();
        const to = String(req.query.to || "").trim();

        if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
            where.push(`DATE(${alias}.${mod.dateCol}) >= ?`);
            params.push(from);
        }

        if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            where.push(`DATE(${alias}.${mod.dateCol}) <= ?`);
            params.push(to);
        }
    }

    return {
        sql: where.length ? "WHERE " + where.join(" AND ") : "",
        params,
        location
    };
}

// Turns a database value into plain text for a report cell.
function cellText(column, value) {

    if (value === null || value === undefined) return "";

    if (value instanceof Date) {
        return column && (column.type === "datetime") ? fmtDateTime(value) : fmtDate(value);
    }

    return String(value);
}


// =====================================================
// 1. SUMMARY
// =====================================================
router.get("/:module/summary", async (req, res) => {

    try {

        const mod = moduleFor(req, res);
        if (!mod) return;

        const key = req.params.module;

        await applyLocation(key, req, res, "t");

        const sc = scope(mod, req);

        const [[total]] = await db.query(
            `SELECT COUNT(*) AS n FROM ${mod.table} t ${sc.sql}`, sc.params
        );

        const charts = [];

        for (const group of mod.groups) {

            const [rows] = await db.query(`
                SELECT COALESCE(NULLIF(CAST(${group.expr("t")} AS CHAR), ''), '(none)') AS label,
                       COUNT(*) AS n
                FROM ${mod.table} t
                ${sc.sql}
                GROUP BY label
                ORDER BY ${group.sort === "label" ? "label" : "n DESC"}
                LIMIT 30
            `, sc.params);

            charts.push({
                title: group.title,
                type: group.chart || "bar",
                labels: rows.map(r => r.label),
                values: rows.map(r => Number(r.n))
            });
        }

        // By location (every module)
        const [byLocation] = await db.query(`
            SELECT COALESCE(NULLIF(${mod.loc("t")}, ''), '(none)') AS label, COUNT(*) AS n
            FROM ${mod.table} t
            ${sc.sql}
            GROUP BY label
            ORDER BY n DESC
            LIMIT 30
        `, sc.params);

        charts.push({
            title: "By location",
            type: "bar",
            labels: byLocation.map(r => r.label),
            values: byLocation.map(r => Number(r.n))
        });

        // Findings and actions for this module
        let findingStats = null;

        if (mod.findings) {

            const ids = `SELECT t.${mod.pk} FROM ${mod.table} t ${sc.sql}`;

            const [[f]] = await db.query(`
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(status = 'Open'), 0) AS open_n,
                       COALESCE(SUM(status = 'Closed'), 0) AS closed_n
                FROM record_findings
                WHERE module = ? AND record_id IN (${ids})
            `, [req.params.module, ...sc.params]);

            const [[a]] = await db.query(`
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(status <> 'Closed'), 0) AS open_n,
                       COALESCE(SUM(status = 'Pending Approval'), 0) AS pending_n,
                       COALESCE(SUM(due_date < CURDATE() AND status <> 'Closed'), 0) AS overdue_n
                FROM record_actions
                WHERE module = ? AND record_id IN (${ids})
            `, [req.params.module, ...sc.params]);

            findingStats = { findings: f, actions: a };

            const [actionStatus] = await db.query(`
                SELECT status AS label, COUNT(*) AS n
                FROM record_actions
                WHERE module = ? AND record_id IN (${ids})
                GROUP BY status
            `, [req.params.module, ...sc.params]);

            if (actionStatus.length > 0) {
                charts.push({
                    title: "Action status",
                    type: "doughnut",
                    labels: actionStatus.map(r => r.label),
                    values: actionStatus.map(r => Number(r.n))
                });
            }
        }

        res.render("tools/summary", {
            title: `${mod.label} - Summary`,
            mod,
            key,
            total: total.n,
            charts,
            findingStats,
            filters: {
                from: req.query.from || "",
                to: req.query.to || ""
            }
        });

    } catch (error) {
        console.error("Error building summary:", error);
        res.status(500).send("Error building the summary");
    }
});


// =====================================================
// 2. REPORT (Excel / Word / PDF)
// =====================================================
router.get("/:module/report.:fmt", async (req, res) => {

    try {

        const mod = moduleFor(req, res);
        if (!mod) return;

        const fmt = String(req.params.fmt).toLowerCase();

        if (!["xlsx", "docx", "pdf"].includes(fmt)) {
            return res.status(400).send("Choose xlsx, docx or pdf.");
        }

        const key = req.params.module;
        const sc = scope(mod, req);
        const columns = reportColumns(mod);

        // Register
        const [rows] = await db.query(`
            SELECT ${columns.map((c, i) => `${displayExpr(c, "t")} AS c${i}`).join(", ")}
            FROM ${mod.table} t
            ${sc.sql}
            ORDER BY ${mod.dateCol ? `t.${mod.dateCol} DESC, ` : ""}t.${mod.pk} DESC
        `, sc.params);

        const sections = [{
            heading: `${mod.label} register`,
            columns: columns.map(c => c.label),
            rows: rows.map(r => columns.map((c, i) => cellText(c, r[`c${i}`])))
        }];

        // Findings and actions
        if (mod.findings) {

            const ids = `SELECT t.${mod.pk} FROM ${mod.table} t ${sc.sql}`;

            const [findings] = await db.query(`
                SELECT (SELECT r.title FROM v_records r WHERE r.module = f.module AND r.record_id = f.record_id) AS record_title,
                       f.description, f.severity, f.status, f.raised_at,
                       (SELECT GROUP_CONCAT(CONCAT('[', rc.category, '] ', rc.description) SEPARATOR '; ')
                          FROM record_root_causes rc WHERE rc.finding_id = f.finding_id) AS root_causes
                FROM record_findings f
                WHERE f.module = ? AND f.record_id IN (${ids})
                ORDER BY f.record_id, f.finding_id
            `, [key, ...sc.params]);

            sections.push({
                heading: "Findings and root causes",
                columns: ["Record", "Finding", "Severity", "Status", "Raised", "Root causes"],
                rows: findings.map(f => [
                    f.record_title, f.description, f.severity, f.status,
                    fmtDate(f.raised_at), f.root_causes || ""
                ])
            });

            const [actions] = await db.query(`
                SELECT (SELECT r.title FROM v_records r WHERE r.module = a.module AND r.record_id = a.record_id) AS record_title,
                       a.description, a.due_date, a.priority, a.status, a.action_party,
                       ro.role_name,
                       (SELECT GROUP_CONCAT(DISTINCT e.employee_name SEPARATOR ', ')
                          FROM v_action_owners o JOIN employees e ON e.employee_id = o.employee_id
                         WHERE o.action_id = a.action_id) AS owners
                FROM record_actions a
                LEFT JOIN roles ro ON ro.role_id = a.responsible_role_id
                WHERE a.module = ? AND a.record_id IN (${ids})
                ORDER BY a.record_id, a.action_id
            `, [key, ...sc.params]);

            sections.push({
                heading: "Actions",
                columns: ["Record", "Action", "Due", "Priority", "Status", "Responsible role", "Current owner(s)", "Party"],
                rows: actions.map(a => [
                    a.record_title, a.description, fmtDate(a.due_date), a.priority, a.status,
                    a.role_name || "", a.owners || "", a.action_party || ""
                ])
            });
        }

        const filters = [];
        if (sc.location) filters.push(`Location: ${sc.location}`);
        if (req.query.from) filters.push(`From: ${req.query.from}`);
        if (req.query.to) filters.push(`To: ${req.query.to}`);

        const title = `${mod.label} Report`;

        const meta = `Generated ${fmtDateTime(new Date())} by ${req.session.user.username}` +
            (filters.length ? ` | ${filters.join(" | ")}` : " | All locations") +
            ` | ${rows.length} record(s)`;

        const fileBase = `${key}-report-${fmtDate(new Date())}`;

        if (fmt === "xlsx") {
            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.xlsx"`);
            return res.send(await buildXlsx({ title, meta, sections }));
        }

        if (fmt === "docx") {
            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.docx"`);
            return res.send(await buildDocx({ title, meta, sections }));
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.pdf"`);
        return res.send(await buildPdf({ title, meta, sections }));

    } catch (error) {
        console.error("Error building report:", error);
        res.status(500).send(`Error building the report: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 3. UPLOAD PAGE + TEMPLATE
// =====================================================
router.get("/:module/upload", async (req, res) => {

    try {

        const mod = moduleFor(req, res);
        if (!mod) return;

        const allowed = await canAddNow(req.session.user, req.params.module);

        res.render("tools/upload", {
            title: `Bulk upload - ${mod.label}`,
            mod,
            key: req.params.module,
            allowed,
            result: null
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading the upload page");
    }
});

router.get("/:module/template.xlsx", async (req, res) => {

    try {

        const mod = moduleFor(req, res);
        if (!mod) return;

        const columns = mod.columns;

        const buffer = await buildXlsx({
            title: `${mod.label} upload template`,
            meta: "Fill one record per row under the header. Columns marked * are required.",
            sections: [
                {
                    heading: "Data",
                    columns: columns.map(c => c.label + (c.required ? " *" : "")),
                    rows: []
                },
                {
                    heading: "Help",
                    columns: ["Column", "Type", "Required", "Notes"],
                    rows: columns.map(c => [
                        c.label,
                        c.type,
                        c.required ? "Yes" : "No",
                        ({
                            date: "YYYY-MM-DD or DD/MM/YYYY",
                            datetime: "YYYY-MM-DD HH:MM",
                            time: "HH:MM",
                            employee: "Employee full name exactly as in the Employees list",
                            department: "Department name exactly as in Departments",
                            role: "Role name exactly as in the roles list",
                            number: "Numbers only"
                        })[c.type] || (c.default ? `Default: ${c.default}` : "")
                    ])
                }
            ]
        });

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${req.params.module}-upload-template.xlsx"`);
        res.send(buffer);

    } catch (error) {
        console.error(error);
        res.status(500).send("Error building the template");
    }
});


// =====================================================
// 4. UPLOAD
// =====================================================

const pad = n => String(n).padStart(2, "0");

// SheetJS returns dates a few seconds off; rounding to the minute fixes that.
function fromExcelDate(d) {
    return new Date(Math.round(d.getTime() / 60000) * 60000);
}

function parseDateValue(value, withTime) {

    if (value === "" || value === null || value === undefined) return null;

    let date = null;
    let time = null;

    if (value instanceof Date) {

        const d = fromExcelDate(value);
        date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        time = `${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

    } else {

        const text = String(value).trim();

        let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);

        if (m) {
            date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
            if (m[4]) time = `${pad(m[4])}:${m[5]}:00`;
        } else if ((m = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/))) {
            // day first (DD/MM/YYYY)
            date = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
            if (m[4]) time = `${pad(m[4])}:${m[5]}:00`;
        } else {
            const parsed = new Date(text);
            if (isNaN(parsed)) return undefined;
            date = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
        }
    }

    // Reject impossible dates such as 2026-02-31
    const check = new Date(`${date}T00:00:00`);
    if (isNaN(check) || fmtDate(check) !== date) return undefined;

    return withTime ? `${date} ${time || "00:00:00"}` : date;
}

async function loadLookups() {

    const build = async (sql, idKey, nameKey) => {
        const [rows] = await db.query(sql);
        const map = new Map();
        for (const r of rows) {
            const k = String(r[nameKey]).trim().toLowerCase();
            if (!map.has(k)) map.set(k, r[idKey]);
        }
        return map;
    };

    return {
        employee: await build("SELECT employee_id, employee_name FROM employees", "employee_id", "employee_name"),
        department: await build("SELECT department_id, department_name FROM departments", "department_id", "department_name"),
        role: await build("SELECT role_id, role_name FROM roles", "role_id", "role_name")
    };
}

// Converts one uploaded cell for a column; returns { value } or { error }.
function convert(column, raw, lookups) {

    const blank = raw === "" || raw === null || raw === undefined ||
        (typeof raw === "string" && raw.trim() === "");

    if (blank) return { value: null };

    switch (column.type) {

        case "number": {
            const n = Number(String(raw).replace(/,/g, "").trim());
            return Number.isFinite(n) ? { value: n } : { error: `${column.label}: "${raw}" is not a number` };
        }

        case "date":
        case "datetime": {
            const v = parseDateValue(raw, column.type === "datetime");
            return v === undefined ? { error: `${column.label}: "${raw}" is not a valid date` } : { value: v };
        }

        case "time": {
            if (raw instanceof Date) {
                const d = fromExcelDate(raw);
                return { value: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
            }
            const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})/);
            return m ? { value: `${pad(m[1])}:${m[2]}` } : { error: `${column.label}: "${raw}" is not a time (HH:MM)` };
        }

        case "employee":
        case "department":
        case "role": {
            const text = String(raw).trim();
            const id = lookups[column.type].get(text.toLowerCase());
            if (id !== undefined) return { value: id };
            return { error: `${column.label}: "${text}" was not found` };
        }

        default:
            return { value: String(raw).trim().slice(0, column.type === "longtext" ? 60000 : 255) };
    }
}

router.post("/:module/upload",
    handleUpload(memoryUpload.single("file")),
    async (req, res) => {

        const mod = moduleFor(req, res);
        if (!mod) return;

        const key = req.params.module;
        const user = req.session.user;

        const render = (result, status = 200) => res.status(status).render("tools/upload", {
            title: `Bulk upload - ${mod.label}`,
            mod,
            key,
            allowed: { ok: true },
            result
        });

        try {

            const allowed = await canAddNow(user, key);

            if (!allowed.ok) {
                return res.status(403).render("tools/upload", {
                    title: `Bulk upload - ${mod.label}`, mod, key, allowed, result: null
                });
            }

            if (!req.file) {
                return render({ fatal: "Choose an .xlsx, .xls, .csv or .docx file to upload." }, 400);
            }

            let parsed;

            try {
                parsed = await parseUpload(req.file);
            } catch (error) {
                return render({ fatal: `Could not read the file: ${error.message}` }, 400);
            }

            const { mapping, unknown } = mapHeaders(parsed.headers, mod.columns);

            const mapped = new Set(Object.values(mapping));
            const missing = mod.columns.filter(c => c.required && !mapped.has(c));

            if (missing.length > 0) {
                return render({
                    fatal: `Missing required column(s): ${missing.map(c => c.label).join(", ")}.`,
                    unknown
                }, 400);
            }

            const lookups = await loadLookups();

            const hasCreatedBy = ["moc", "drills", "meetings"].includes(key);

            let inserted = 0;
            const errors = [];

            for (const [index, raw] of parsed.rows.entries()) {

                const rowNo = index + 2;   // header is row 1

                const cells = Object.entries(mapping).map(([header, column]) => [column, raw[header]]);

                if (cells.every(([, v]) => v === "" || v === null || v === undefined)) continue;

                const record = {};
                const problems = [];

                for (const column of mod.columns) {

                    const entry = cells.find(([c]) => c === column);
                    const result = entry ? convert(column, entry[1], lookups) : { value: null };

                    if (result.error) problems.push(result.error);

                    let value = result.value;

                    if ((value === null || value === undefined) && column.default !== undefined) {
                        value = column.default;
                    }

                    if (column.required && (value === null || value === undefined) && !result.error) {
                        problems.push(`${column.label} is required`);
                    }

                    record[column.key] = value === undefined ? null : value;
                }

                if (problems.length > 0) {
                    errors.push({ row: rowNo, message: problems.join("; ") });
                    continue;
                }

                try {

                    if (mod.prepare) await mod.prepare(record);

                    if (hasCreatedBy) record.created_by = user.user_id;

                    const keys = Object.keys(record);

                    await db.query(
                        `INSERT INTO ${mod.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
                        keys.map(k => record[k])
                    );

                    inserted++;

                } catch (error) {

                    errors.push({
                        row: rowNo,
                        message: error.code === "ER_DUP_ENTRY"
                            ? "Duplicate record (a unique value already exists)"
                            : (error.sqlMessage || error.message)
                    });
                }
            }

            return render({ inserted, errors, unknown, total: inserted + errors.length });

        } catch (error) {
            console.error("Bulk upload failed:", error);
            res.status(500).send(`Bulk upload failed: ${error.sqlMessage || error.message}`);
        }
    }
);

module.exports = router;
