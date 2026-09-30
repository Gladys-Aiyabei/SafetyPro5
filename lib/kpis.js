// =====================================================
// KPI TARGETS (dashboard sheet "KPI Targets")
//
//  * CATALOGUE describes every KPI: where its number comes from, whether higher or
//    lower is better, and a default target + amber margin.
//  * An Admin can override the target / margin per KPI (table kpi_targets).
//    A saved row with an empty target means "no target" (the default is not used).
//  * Status is worked out every time the sheet is opened:
//        On target   actual meets the target
//        At risk     misses it, but by no more than the margin
//        Off target  misses it by more than the margin
//        No target   no target set
//        No data     nothing recorded yet to measure (e.g. 0 audits due)
//  * Every measure respects the dashboard filters (period, department, user, location).
// =====================================================

const db = require("../db");
const { computeCompliance, planProgress } = require("./compliance");

const sql = async (text, params = []) => (await db.query(text, params))[0];

const STATUSES = ["On target", "At risk", "Off target", "No target", "No data"];


// =====================================================
// TABLE (created on first use; the same DDL is in sql/kpi_targets.sql)
// =====================================================

let tableReady = null;

function ensureTable() {

    if (!tableReady) {
        tableReady = db.query(`
            CREATE TABLE IF NOT EXISTS kpi_targets (
                kpi_key     VARCHAR(40)   NOT NULL,
                target      DECIMAL(14,2) NULL,
                margin      DECIMAL(14,2) NOT NULL DEFAULT 0,
                updated_by  INT           NULL,
                updated_at  TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (kpi_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
        ).catch(error => { tableReady = null; throw error; });
    }

    return tableReady;
}


// =====================================================
// HELPERS
// =====================================================

const pct = (part, whole) => (Number(whole) > 0 ? (Number(part) / Number(whole)) * 100 : null);
const num = v => (v === null || v === undefined ? null : Number(v));
const ofDetail = (part, whole, noun) => `${Number(part)} of ${Number(whole)} ${noun}`;

// Records of one module inside the dashboard filters: FROM <table> JOIN v_records r ... WHERE ...
function joined(scope, module, table, alias, pk, opts) {
    const s = scope(module, opts);
    return {
        from: `FROM ${table} ${alias} JOIN v_records r ON r.module = '${module}' AND r.record_id = ${alias}.${pk}
               WHERE 1 = 1 ${s.and}`,
        params: s.params
    };
}

// Monthly HSSEQ data has no department or owner, so only period and location apply to it.
const SITE_ONLY = { siteOnly: true };

// Audit / inspection statuses that mean "not carried out yet".
const NOT_DONE = "'', 'Planned', 'Scheduled', 'In Progress', 'Pending', 'Cancelled'";


// =====================================================
// CATALOGUE
//   unit:   "%", "count", "rate" (per 1,000,000 hours), "t", "m3"
//   better: "higher" | "lower"
//   source: which fields are read (shown on the sheet)
//   measure(scope, f) -> { value, detail }   value null = no data
// =====================================================

const CATALOGUE = [

    // ---------- Incidents ----------
    {
        key: "inc_high", group: "Incidents", label: "High / critical incidents",
        unit: "count", better: "lower", target: 0, margin: 1,
        source: "incidents.severity", link: "/incidents",
        async measure(scope) {
            const q = joined(scope, "incidents", "incidents", "i", "incident_id");
            const [r] = await sql(`SELECT COUNT(*) AS total, COALESCE(SUM(i.severity IN ('High', 'Critical')), 0) AS n ${q.from}`, q.params);
            return { value: Number(r.n), detail: ofDetail(r.n, r.total, "incidents") };
        }
    },
    {
        key: "inc_closure", group: "Incidents", label: "Incidents closed",
        unit: "%", better: "higher", target: 90, margin: 10,
        source: "incidents.status", link: "/incidents",
        async measure(scope) {
            const q = joined(scope, "incidents", "incidents", "i", "incident_id");
            const [r] = await sql(`SELECT COUNT(*) AS total, COALESCE(SUM(i.status = 'Closed'), 0) AS n ${q.from}`, q.params);
            return { value: pct(r.n, r.total), detail: ofDetail(r.n, r.total, "closed") };
        }
    },
    {
        key: "inc_near_miss", group: "Incidents", label: "Near misses reported",
        unit: "count", better: "higher", target: null, margin: 0,
        source: "incidents.incident_type contains \"near miss\"", link: "/incidents",
        async measure(scope) {
            const q = joined(scope, "incidents", "incidents", "i", "incident_id");
            const [r] = await sql(`SELECT COALESCE(SUM(LOWER(i.incident_type) LIKE '%near miss%'), 0) AS n ${q.from}`, q.params);
            return { value: Number(r.n), detail: `${Number(r.n)} reported` };
        }
    },
    {
        key: "ltifr", group: "Incidents", label: "Lost time injury frequency rate (LTIFR)",
        unit: "rate", better: "lower", target: 0, margin: 0.5,
        source: "incidents.incident_type contains \"lost time\" or is \"LTI\"; hsseq_data exposure hours (staff + contractors)",
        link: "/hsseq",
        async measure(scope) {
            const q = joined(scope, "incidents", "incidents", "i", "incident_id", SITE_ONLY);
            const [inc] = await sql(`
                SELECT COALESCE(SUM(LOWER(i.incident_type) LIKE '%lost time%' OR UPPER(TRIM(i.incident_type)) = 'LTI'), 0) AS n
                ${q.from}`, q.params);

            const h = joined(scope, "hsseq", "hsseq_data", "h", "hsseq_id", SITE_ONLY);
            const [hrs] = await sql(`
                SELECT COALESCE(SUM(COALESCE(h.exposure_hours_staff, 0) + COALESCE(h.exposure_hours_contractors, 0)), 0) AS hours
                ${h.from}`, h.params);

            const hours = Number(hrs.hours);
            return {
                value: hours > 0 ? (Number(inc.n) * 1000000) / hours : null,
                detail: `${Number(inc.n)} LTI over ${hours.toLocaleString("en-GB")} hours`
            };
        }
    },

    // ---------- Findings and actions ----------
    {
        key: "find_closure", group: "Findings & actions", label: "Findings closed",
        unit: "%", better: "higher", target: 80, margin: 10,
        source: "record_findings.status (all modules)", link: "/dashboard?sheet=findings",
        async measure(scope) {
            const s = scope("");
            const [r] = await sql(`
                SELECT COUNT(*) AS total, COALESCE(SUM(fi.status = 'Closed'), 0) AS n
                FROM record_findings fi JOIN v_records r ON r.module = fi.module AND r.record_id = fi.record_id
                WHERE 1 = 1 ${s.and}`, s.params);
            return { value: pct(r.n, r.total), detail: ofDetail(r.n, r.total, "closed") };
        }
    },
    {
        key: "act_overdue", group: "Findings & actions", label: "Overdue actions",
        unit: "count", better: "lower", target: 0, margin: 2,
        source: "record_actions.due_date, status", link: "/dashboard?sheet=actions",
        async measure(scope) {
            const s = scope("");
            const [r] = await sql(`
                SELECT COALESCE(SUM(a.status <> 'Closed'), 0) AS open_n,
                       COALESCE(SUM(a.status <> 'Closed' AND a.due_date < CURDATE()), 0) AS n
                FROM record_actions a JOIN v_records r ON r.module = a.module AND r.record_id = a.record_id
                WHERE 1 = 1 ${s.and}`, s.params);
            return { value: Number(r.n), detail: `${Number(r.n)} of ${Number(r.open_n)} open actions` };
        }
    },
    {
        key: "act_on_time", group: "Findings & actions", label: "Actions completed on time",
        unit: "%", better: "higher", target: 90, margin: 10,
        source: "record_actions.completed_at (or approved_at) vs due_date, closed actions only",
        link: "/dashboard?sheet=actions",
        async measure(scope) {
            const s = scope("");
            const [r] = await sql(`
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(DATE(COALESCE(a.completed_at, a.approved_at)) <= a.due_date), 0) AS n
                FROM record_actions a JOIN v_records r ON r.module = a.module AND r.record_id = a.record_id
                WHERE a.status = 'Closed' AND a.due_date IS NOT NULL
                  AND COALESCE(a.completed_at, a.approved_at) IS NOT NULL ${s.and}`, s.params);
            return { value: pct(r.n, r.total), detail: ofDetail(r.n, r.total, "on time") };
        }
    },

    // ---------- Audits and inspections ----------
    // "Carried out" = any status except the not-yet-done ones, so "Pending Actions" and
    // "Action Required" (done, with follow-up open) count as carried out.
    {
        key: "aud_done", group: "Audits & inspections", label: "Audits carried out when due",
        unit: "%", better: "higher", target: 90, margin: 10,
        source: "audits.audit_date, status (not Planned / In Progress / Pending)", link: "/audits",
        async measure(scope) {
            const q = joined(scope, "audits", "audits", "t", "audit_id");
            const [r] = await sql(`
                SELECT COALESCE(SUM(t.audit_date <= CURDATE() AND COALESCE(t.status, '') <> 'Cancelled'), 0) AS due,
                       COALESCE(SUM(t.audit_date <= CURDATE() AND COALESCE(t.status, '') NOT IN (${NOT_DONE})), 0) AS n
                ${q.from}`, q.params);
            return { value: pct(r.n, r.due), detail: ofDetail(r.n, r.due, "due") };
        }
    },
    {
        key: "insp_done", group: "Audits & inspections", label: "Inspections carried out when due",
        unit: "%", better: "higher", target: 95, margin: 5,
        source: "inspections.inspection_date, status (not Pending / Planned / In Progress)", link: "/inspections",
        async measure(scope) {
            const q = joined(scope, "inspections", "inspections", "t", "inspection_id");
            const [r] = await sql(`
                SELECT COALESCE(SUM(t.inspection_date <= CURDATE() AND COALESCE(t.status, '') <> 'Cancelled'), 0) AS due,
                       COALESCE(SUM(t.inspection_date <= CURDATE() AND COALESCE(t.status, '') NOT IN (${NOT_DONE})), 0) AS n
                ${q.from}`, q.params);
            return { value: pct(r.n, r.due), detail: ofDetail(r.n, r.due, "due") };
        }
    },
    {
        key: "chk_compliance", group: "Audits & inspections", label: "Checklist compliance",
        unit: "%", better: "higher", target: 95, margin: 5,
        source: "checklist_responses.result (Compliant vs Non-compliant, N/A ignored)", link: "/checklists",
        async measure(scope) {
            const s = scope("");
            const [r] = await sql(`
                SELECT COALESCE(SUM(cr.result IN ('Compliant', 'Non-compliant')), 0) AS total,
                       COALESCE(SUM(cr.result = 'Compliant'), 0) AS n
                FROM checklist_responses cr JOIN v_records r ON r.module = cr.module AND r.record_id = cr.record_id
                WHERE 1 = 1 ${s.and}`, s.params);
            return { value: pct(r.n, r.total), detail: ofDetail(r.n, r.total, "answers compliant") };
        }
    },

    // ---------- Risk and permits ----------
    {
        key: "risk_actioned", group: "Risk & permits", label: "High / critical risks with an action plan",
        unit: "%", better: "higher", target: 100, margin: 10,
        source: "risk_assessments.risk_level; record_actions on the risk", link: "/risk-assessments",
        async measure(scope) {
            const q = joined(scope, "risks", "risk_assessments", "k", "risk_id");
            const [r] = await sql(`
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(EXISTS (SELECT 1 FROM record_actions a WHERE a.module = 'risks' AND a.record_id = k.risk_id)), 0) AS n
                ${q.from} AND k.risk_level IN ('High', 'Critical')`, q.params);
            return { value: pct(r.n, r.total), detail: ofDetail(r.n, r.total, "high / critical risks") };
        }
    },
    {
        key: "ptw_lapsed", group: "Risk & permits", label: "Permits expired but not closed",
        unit: "count", better: "lower", target: 0, margin: 0,
        source: "permits.expiry_date, status", link: "/permits",
        async measure(scope) {
            const q = joined(scope, "permits", "permits", "p", "permit_id");
            const [r] = await sql(`
                SELECT COUNT(*) AS total, COALESCE(SUM(p.expiry_date < NOW() AND p.status <> 'Closed'), 0) AS n
                ${q.from}`, q.params);
            return { value: Number(r.n), detail: ofDetail(r.n, r.total, "permits") };
        }
    },
    {
        key: "moc_temp_expired", group: "Risk & permits", label: "Temporary changes past expiry (MOC)",
        unit: "count", better: "lower", target: 0, margin: 0,
        source: "moc_records.duration_type = Temporary, expiry_date, status", link: "/moc",
        async measure(scope) {
            const q = joined(scope, "moc", "moc_records", "m", "moc_id");
            const [r] = await sql(`
                SELECT COALESCE(SUM(m.duration_type = 'Temporary'), 0) AS total,
                       COALESCE(SUM(m.duration_type = 'Temporary' AND m.expiry_date < CURDATE()
                                    AND m.status NOT IN ('Closed', 'Rejected')), 0) AS n
                ${q.from}`, q.params);
            return { value: Number(r.n), detail: ofDetail(r.n, r.total, "temporary changes") };
        }
    },

    // ---------- Emergency and meetings ----------
    {
        key: "drill_done", group: "Emergency & meetings", label: "Drills done when due",
        unit: "%", better: "higher", target: 100, margin: 10,
        source: "erp_drills.planned_date, status", link: "/erp",
        async measure(scope) {
            const q = joined(scope, "drills", "erp_drills", "d", "drill_id");
            const [r] = await sql(`
                SELECT COALESCE(SUM(d.planned_date <= CURDATE() AND d.status <> 'Cancelled'), 0) AS due,
                       COALESCE(SUM(d.planned_date <= CURDATE() AND d.status = 'Completed'), 0) AS n
                ${q.from}`, q.params);
            return { value: pct(r.n, r.due), detail: ofDetail(r.n, r.due, "due") };
        }
    },
    {
        key: "mtg_held", group: "Emergency & meetings", label: "Safety meetings held as scheduled",
        unit: "%", better: "higher", target: 90, margin: 10,
        source: "meetings.meeting_date, status", link: "/meetings",
        async measure(scope) {
            const q = joined(scope, "meetings", "meetings", "mt", "meeting_id");
            const [r] = await sql(`
                SELECT COALESCE(SUM(mt.meeting_date <= CURDATE() AND mt.status <> 'Cancelled'), 0) AS due,
                       COALESCE(SUM(mt.meeting_date <= CURDATE() AND mt.status = 'Held'), 0) AS n
                ${q.from}`, q.params);
            return { value: pct(r.n, r.due), detail: ofDetail(r.n, r.due, "due") };
        }
    },

    // ---------- Training ----------
    {
        key: "trn_fully", group: "Training", label: "Staff fully trained for their role",
        unit: "%", better: "higher", target: 90, margin: 10,
        source: "training vs role_training_requirements (valid and endorsed); staff with no requirements left out",
        link: "/training/matrix",
        async measure(scope, f) {
            const { summary: s } = await computeCompliance({
                department_id: f.department || undefined, employee_id: f.user || undefined, location: f.location || undefined
            });
            const assessed = s.fully + s.gaps;
            return { value: pct(s.fully, assessed), detail: ofDetail(s.fully, assessed, "staff") };
        }
    },
    {
        key: "trn_plan", group: "Training", label: "Training plan delivered when due",
        unit: "%", better: "higher", target: 90, margin: 10,
        source: "annual_training_plans (month ended or completed) vs endorsed training records", link: "/training",
        async measure(scope, f) {
            const year = f.year || new Date().getFullYear();
            const today = new Date();
            const plans = (await planProgress(year)).filter(p =>
                p.implementation !== "Cancelled" &&
                (p.implementation === "Completed" || new Date(year, p.target_month || 12, 0) < today));
            const done = plans.filter(p => p.implementation === "Completed").length;
            return { value: pct(done, plans.length), detail: `${ofDetail(done, plans.length, "plan items due")} (${year})` };
        }
    },
    {
        key: "trn_pending", group: "Training", label: "Trainings awaiting endorsement",
        unit: "count", better: "lower", target: 0, margin: 5,
        source: "training.endorsed_at is empty", link: "/training",
        async measure(scope) {
            const q = joined(scope, "training", "training", "t", "training_id");
            const [r] = await sql(`SELECT COALESCE(SUM(t.endorsed_at IS NULL), 0) AS n ${q.from}`, q.params);
            return { value: Number(r.n), detail: `${Number(r.n)} waiting for the line manager` };
        }
    },

    // ---------- Environment ----------
    {
        key: "env_ghg", group: "Environment", label: "GHG emissions",
        unit: "t", better: "lower", target: null, margin: 0,
        source: "hsseq_data.ghg_emissions_tonnes", link: "/hsseq",
        async measure(scope) {
            const q = joined(scope, "hsseq", "hsseq_data", "h", "hsseq_id", SITE_ONLY);
            const [r] = await sql(`SELECT COUNT(h.ghg_emissions_tonnes) AS months, SUM(h.ghg_emissions_tonnes) AS n ${q.from}`, q.params);
            return { value: num(r.n), detail: `${Number(r.months)} monthly entries` };
        }
    },
    {
        key: "env_haz_waste", group: "Environment", label: "Hazardous waste",
        unit: "t", better: "lower", target: null, margin: 0,
        source: "hsseq_data.hazardous_waste_tonnes", link: "/hsseq",
        async measure(scope) {
            const q = joined(scope, "hsseq", "hsseq_data", "h", "hsseq_id", SITE_ONLY);
            const [r] = await sql(`SELECT COUNT(h.hazardous_waste_tonnes) AS months, SUM(h.hazardous_waste_tonnes) AS n ${q.from}`, q.params);
            return { value: num(r.n), detail: `${Number(r.months)} monthly entries` };
        }
    },
    {
        key: "env_water", group: "Environment", label: "Water consumption",
        unit: "m3", better: "lower", target: null, margin: 0,
        source: "hsseq_data.water_consumption_m3", link: "/hsseq",
        async measure(scope) {
            const q = joined(scope, "hsseq", "hsseq_data", "h", "hsseq_id", SITE_ONLY);
            const [r] = await sql(`SELECT COUNT(h.water_consumption_m3) AS months, SUM(h.water_consumption_m3) AS n ${q.from}`, q.params);
            return { value: num(r.n), detail: `${Number(r.months)} monthly entries` };
        }
    }
];

const BY_KEY = Object.fromEntries(CATALOGUE.map(k => [k.key, k]));


// =====================================================
// STATUS
// =====================================================

function statusOf(value, target, margin, better) {

    if (target === null || target === undefined) return "No target";
    if (value === null || value === undefined || Number.isNaN(value)) return "No data";

    const miss = better === "higher" ? target - value : value - target;

    if (miss <= 0) return "On target";
    if (miss <= margin) return "At risk";
    return "Off target";
}

function formatValue(value, unit) {

    if (value === null || value === undefined) return "-";

    const round = (v, dp) => Number(v.toFixed(dp)).toLocaleString("en-GB");

    if (unit === "%") return round(value, 1) + "%";
    if (unit === "rate") return round(value, 2);
    if (unit === "count") return round(value, 0);
    return `${round(value, 2)} ${unit}`;
}

// "≥ 90%", "≤ 0"
function formatTarget(k, target) {
    if (target === null || target === undefined) return "-";
    return (k.better === "higher" ? "≥ " : "≤ ") + formatValue(target, k.unit);
}


// =====================================================
// READ / WRITE TARGETS
// =====================================================

async function loadTargets() {

    await ensureTable();

    const saved = await sql("SELECT kpi_key, target, margin, updated_at FROM kpi_targets");
    const byKey = Object.fromEntries(saved.map(r => [r.kpi_key, r]));

    return Object.fromEntries(CATALOGUE.map(k => {
        const s = byKey[k.key];
        return [k.key, s
            ? { target: num(s.target), margin: Number(s.margin), custom: true, updated_at: s.updated_at }
            : { target: k.target, margin: k.margin, custom: false, updated_at: null }];
    }));
}

// body: { target_<key>: "90", margin_<key>: "5", ... } -> { ok, message }
async function saveTargets(body, user) {

    await ensureTable();

    const parse = v => {
        const t = String(v === undefined || v === null ? "" : v).trim().replace(",", ".");
        if (t === "") return { empty: true };
        const n = Number(t);
        return Number.isFinite(n) ? { n } : { bad: true };
    };

    const rows = [];
    const problems = [];

    for (const k of CATALOGUE) {

        if (!(`target_${k.key}` in body)) continue;

        const t = parse(body[`target_${k.key}`]);
        const m = parse(body[`margin_${k.key}`]);

        if (t.bad) problems.push(`${k.label}: target must be a number`);
        if (m.bad || (m.n !== undefined && m.n < 0)) problems.push(`${k.label}: margin must be 0 or more`);
        if (k.unit === "%" && t.n !== undefined && (t.n < 0 || t.n > 100)) problems.push(`${k.label}: target must be between 0 and 100`);

        rows.push([k.key, t.empty ? null : t.n, m.empty ? 0 : m.n, user.user_id || null]);
    }

    if (problems.length) return { ok: false, message: "Nothing saved. " + problems.join("; ") + "." };
    if (!rows.length) return { ok: false, message: "Nothing to save." };

    await db.query(`
        INSERT INTO kpi_targets (kpi_key, target, margin, updated_by) VALUES ?
        ON DUPLICATE KEY UPDATE target = VALUES(target), margin = VALUES(margin), updated_by = VALUES(updated_by)`,
        [rows]);

    return { ok: true, message: `Targets saved for ${rows.length} KPIs.` };
}

async function resetTargets() {
    await ensureTable();
    await db.query("DELETE FROM kpi_targets");
    return { ok: true, message: "All KPI targets are back to their defaults." };
}


// =====================================================
// EVALUATE
//   scope(moduleKey, opts) -> { and, params }  (record filter over v_records alias r)
//   f: dashboard filters
// =====================================================

async function evaluateKpis(scope, f) {

    const targets = await loadTargets();

    return Promise.all(CATALOGUE.map(async k => {

        const t = targets[k.key];
        let value = null;
        let detail = "";
        let error = null;

        try {
            ({ value, detail } = await k.measure(scope, f));
        } catch (e) {
            // One broken measure (e.g. a module whose table is missing) must not hide the others.
            console.error(`KPI ${k.key} failed:`, e.sqlMessage || e.message);
            error = e.sqlMessage || e.message;
        }

        const status = error ? "No data" : statusOf(value, t.target, t.margin, k.better);

        return {
            key: k.key, group: k.group, label: k.label, unit: k.unit, better: k.better,
            source: k.source, link: k.link,
            value, detail: error ? "Could not be measured: " + error : detail,
            target: t.target, margin: t.margin, custom: t.custom,
            defaultTarget: k.target, defaultMargin: k.margin,
            status,
            shown: { value: formatValue(value, k.unit), target: formatTarget(k, t.target) }
        };
    }));
}

module.exports = { CATALOGUE, BY_KEY, STATUSES, evaluateKpis, saveTargets, resetTargets, statusOf };
