// =====================================================
// MODULE REGISTRY
// One description of every module. It drives:
//   - the location filter on each list page
//   - bulk upload (Excel / Word)
//   - Excel / Word / PDF reports
//   - the record-summary charts
//   - the findings / root cause / action panel (findings: true)
//
// Column types: text, longtext, number, date, datetime, time,
//               employee, department, role   (the last three are looked up by name)
// =====================================================

const db = require("../db");


// -----------------------------------------------------
// Shared building blocks
// -----------------------------------------------------

const DEPT_LOC = (deptExpr) =>
    `(SELECT d.location FROM departments d WHERE d.department_id = ${deptExpr} LIMIT 1)`;

const EMP_DEPT_LOC = (empExpr) =>
    `(SELECT d.location FROM departments d JOIN employees e ON e.department_id = d.department_id WHERE e.employee_id = ${empExpr} LIMIT 1)`;

const monthOf = (col) => (a) => `DATE_FORMAT(${a}.${col}, '%Y-%m')`;

const col = (key, label, type = "text", extra = {}) => ({ key, label, type, ...extra });

function levelFor(score) {
    if (score <= 4) return "Low";
    if (score <= 9) return "Medium";
    if (score <= 15) return "High";
    return "Critical";
}

// Auto-numbering for MOC-YYYY-NNN
async function nextMocNumber(year) {

    const [rows] = await db.query(
        "SELECT COUNT(*) AS n FROM moc_records WHERE moc_number LIKE ?",
        [`MOC-${year}-%`]
    );

    let n = rows[0].n + 1;

    for (; ;) {
        const candidate = `MOC-${year}-${String(n).padStart(3, "0")}`;
        const [dup] = await db.query(
            "SELECT 1 FROM moc_records WHERE moc_number = ?", [candidate]
        );
        if (dup.length === 0) return candidate;
        n++;
    }
}


// -----------------------------------------------------
// The modules
// -----------------------------------------------------

const MODULES = {

    incidents: {
        label: "Incidents",
        table: "incidents",
        pk: "incident_id",
        path: "/incidents",
        viewPath: id => `/incidents/view/${id}`,
        dateCol: "incident_date",
        findings: true,
        loc: a => `${a}.location`,
        columns: [
            col("incident_date", "Incident Date", "datetime", { required: true }),
            col("incident_type", "Incident Type"),
            col("severity", "Severity"),
            col("location", "Location"),
            col("description", "Description", "longtext"),
            col("immediate_action", "Immediate Action", "longtext"),
            col("reported_by", "Reported By", "employee"),
            col("status", "Status", "text", { default: "Open" })
        ],
        groups: [
            { title: "By status", expr: a => `${a}.status`, chart: "doughnut" },
            { title: "By type", expr: a => `${a}.incident_type`, chart: "bar" },
            { title: "By severity", expr: a => `${a}.severity`, chart: "doughnut" },
            { title: "By month", expr: monthOf("incident_date"), chart: "line", sort: "label" }
        ]
    },

    audits: {
        label: "Audits",
        table: "audits",
        pk: "audit_id",
        path: "/audits",
        viewPath: id => `/audits/view/${id}`,
        dateCol: "audit_date",
        findings: true,
        checklists: true,
        loc: a => DEPT_LOC(`${a}.department_id`),
        columns: [
            col("audit_date", "Audit Date", "date", { required: true }),
            col("audit_type", "Audit Type"),
            col("department_id", "Department", "department"),
            col("auditor", "Auditor"),
            col("findings", "Findings Summary", "longtext"),
            col("score", "Score", "number"),
            col("status", "Status", "text", { default: "Planned" })
        ],
        groups: [
            { title: "By status", expr: a => `${a}.status`, chart: "doughnut" },
            { title: "By audit type", expr: a => `${a}.audit_type`, chart: "bar" },
            { title: "By month", expr: monthOf("audit_date"), chart: "line", sort: "label" }
        ]
    },

    inspections: {
        label: "Inspections",
        table: "inspections",
        pk: "inspection_id",
        path: "/inspections",
        viewPath: id => `/inspections/view/${id}`,
        dateCol: "inspection_date",
        findings: true,
        checklists: true,
        loc: a => `${a}.location`,
        columns: [
            col("inspection_date", "Inspection Date", "date", { required: true }),
            col("inspection_type", "Inspection Type"),
            col("location", "Location"),
            col("inspector_id", "Inspector", "employee"),
            col("findings", "Findings Summary", "longtext"),
            col("overall_score", "Overall Score", "number"),
            col("status", "Status", "text", { default: "Pending" })
        ],
        groups: [
            { title: "By status", expr: a => `${a}.status`, chart: "doughnut" },
            { title: "By inspection type", expr: a => `${a}.inspection_type`, chart: "bar" },
            { title: "By month", expr: monthOf("inspection_date"), chart: "line", sort: "label" }
        ]
    },

    permits: {
        label: "Permits to Work",
        table: "permits",
        pk: "permit_id",
        path: "/permits",
        viewPath: () => "/permits",
        dateCol: "issue_date",
        findings: true,
        loc: a => `${a}.location`,
        columns: [
            col("permit_number", "Permit Number", "text", { required: true }),
            col("permit_type", "Permit Type", "text", { required: true }),
            col("work_description", "Work Description", "longtext"),
            col("location", "Location"),
            col("requested_by", "Requested By", "employee"),
            col("approved_by", "Approved By", "employee"),
            col("issue_date", "Issue Date", "datetime"),
            col("expiry_date", "Expiry Date", "datetime"),
            col("status", "Status", "text", { default: "Pending" })
        ],
        groups: [
            { title: "By status", expr: a => `${a}.status`, chart: "doughnut" },
            { title: "By permit type", expr: a => `${a}.permit_type`, chart: "bar" },
            { title: "By month", expr: monthOf("issue_date"), chart: "line", sort: "label" }
        ]
    },

    risks: {
        label: "Risk Assessments",
        table: "risk_assessments",
        pk: "risk_id",
        path: "/risk-assessments",
        viewPath: () => "/risk-assessments",
        dateCol: "assessment_date",
        findings: true,
        loc: a => `COALESCE(${a}.location, ${EMP_DEPT_LOC(`${a}.responsible_person`)})`,
        columns: [
            col("activity", "Activity", "text", { required: true }),
            col("hazard", "Hazard"),
            col("consequence", "Consequence"),
            col("likelihood", "Likelihood (1-5)", "number"),
            col("severity", "Severity (1-5)", "number"),
            col("control_measures", "Control Measures", "longtext"),
            col("responsible_person", "Responsible Person", "employee"),
            col("assessment_date", "Assessment Date", "date"),
            col("location", "Location")
        ],
        // risk_score and risk_level are calculated, never typed in
        computed: ["risk_score", "risk_level"],
        reportExtra: [col("risk_score", "Risk Score", "number"), col("risk_level", "Risk Level")],
        prepare: async (row) => {
            const l = Math.min(5, Math.max(1, Number(row.likelihood) || 1));
            const s = Math.min(5, Math.max(1, Number(row.severity) || 1));
            row.likelihood = l;
            row.severity = s;
            row.risk_score = l * s;
            row.risk_level = levelFor(l * s);
            return row;
        },
        groups: [
            { title: "By risk level", expr: a => `${a}.risk_level`, chart: "doughnut" },
            { title: "By activity", expr: a => `${a}.activity`, chart: "bar" },
            { title: "By month", expr: monthOf("assessment_date"), chart: "line", sort: "label" }
        ]
    },

    ppe: {
        label: "PPE Inventory",
        table: "ppe_inventory",
        pk: "id",
        path: "/ppe",
        viewPath: () => "/ppe",
        dateCol: "created_at",
        findings: true,
        loc: a => `(SELECT d.location FROM departments d WHERE d.department_name = ${a}.department LIMIT 1)`,
        columns: [
            col("item_name", "Item Name", "text", { required: true }),
            col("category", "Category"),
            col("quantity", "Quantity", "number"),
            col("department", "Department"),
            col("status", "Status", "text", { default: "Available" }),
            col("expiry_date", "Expiry Date", "date")
        ],
        groups: [
            { title: "By status", expr: a => `${a}.status`, chart: "doughnut" },
            { title: "By category", expr: a => `${a}.category`, chart: "bar" }
        ]
    },

    hsseq: {
        label: "HSSEQ Data",
        table: "hsseq_data",
        pk: "hsseq_id",
        path: "/hsseq",
        viewPath: id => `/hsseq/view/${id}`,
        dateCol: null,
        findings: true,
        loc: a => `${a}.location`,
        columns: [
            col("record_month", "Month (1-12)", "number", { required: true }),
            col("record_year", "Year", "number", { required: true }),
            col("hazardous_waste_tonnes", "Hazardous Waste (t)", "number"),
            col("non_hazardous_waste_tonnes", "Non-Hazardous Waste (t)", "number"),
            col("water_consumption_m3", "Water (m3)", "number"),
            col("exposure_hours_contractors", "Exposure Hrs Contractors", "number"),
            col("exposure_hours_staff", "Exposure Hrs Staff", "number"),
            col("kms_light_vehicles", "Km Light Vehicles", "number"),
            col("kms_heavy_goods_vehicles", "Km Heavy Vehicles", "number"),
            col("ghg_emissions_tonnes", "GHG Emissions (t)", "number"),
            col("location", "Location")
        ],
        groups: [
            { title: "Records by year", expr: a => `${a}.record_year`, chart: "bar", sort: "label" }
        ]
    },

    training: {
        label: "Training Records",
        table: "training",
        pk: "training_id",
        path: "/training",
        viewPath: () => "/training",
        dateCol: "training_date",
        findings: true,
        loc: a => EMP_DEPT_LOC(`${a}.employee_id`),
        columns: [
            col("employee_id", "Employee", "employee", { required: true }),
            col("training_name", "Training Name", "text", { required: true }),
            col("training_date", "Training Date", "date"),
            col("expiry_date", "Expiry Date", "date"),
            col("trainer", "Trainer"),
            col("certificate_number", "Certificate Number"),
            col("status", "Status", "text", { default: "Pending Endorsement" })
        ],
        groups: [
            { title: "By status", expr: a => `${a}.status`, chart: "doughnut" },
            { title: "By training", expr: a => `${a}.training_name`, chart: "bar" },
            { title: "By month", expr: monthOf("training_date"), chart: "line", sort: "label" }
        ]
    },

    moc: {
        label: "Management of Change",
        table: "moc_records",
        pk: "moc_id",
        path: "/moc",
        viewPath: id => `/moc/view/${id}`,
        dateCol: "request_date",
        findings: true,
        loc: a => `${a}.location`,
        columns: [
            col("moc_number", "MOC Number"),
            col("title", "Title", "text", { required: true }),
            col("change_type", "Change Type", "text", { required: true }),
            col("duration_type", "Permanent / Temporary", "text", { default: "Permanent" }),
            col("location", "Location"),
            col("description", "Description", "longtext"),
            col("reason", "Reason for Change", "longtext"),
            col("risk_level", "Risk Level"),
            col("proposed_by", "Proposed By", "employee"),
            col("approver_id", "Approver", "employee"),
            col("request_date", "Request Date", "date"),
            col("planned_date", "Planned Implementation", "date"),
            col("expiry_date", "Expiry (temporary)", "date"),
            col("status", "Status", "text", { default: "Submitted" })
        ],
        prepare: async (row) => {
            if (!row.moc_number) {
                const year = row.request_date
                    ? String(row.request_date).slice(0, 4)
                    : String(new Date().getFullYear());
                row.moc_number = await nextMocNumber(year);
            }
            return row;
        },
        groups: [
            { title: "By status", expr: a => `${a}.status`, chart: "doughnut" },
            { title: "By change type", expr: a => `${a}.change_type`, chart: "bar" },
            { title: "Permanent vs temporary", expr: a => `${a}.duration_type`, chart: "doughnut" },
            { title: "By month", expr: monthOf("request_date"), chart: "line", sort: "label" }
        ]
    },

    drills: {
        label: "Emergency Drills",
        table: "erp_drills",
        pk: "drill_id",
        path: "/erp",
        viewPath: id => `/erp/view/${id}`,
        dateCol: "planned_date",
        findings: true,
        loc: a => `${a}.location`,
        columns: [
            col("plan_year", "Plan Year", "number"),
            col("drill_type", "Drill Type", "text", { required: true }),
            col("title", "Title", "text", { required: true }),
            col("scenario", "Scenario", "longtext"),
            col("location", "Location"),
            col("planned_date", "Planned Date", "date", { required: true }),
            col("actual_date", "Actual Date", "date"),
            col("coordinator_id", "Coordinator", "employee"),
            col("participants", "Participants", "number"),
            col("duration_minutes", "Duration (min)", "number"),
            col("status", "Status", "text", { default: "Planned" }),
            col("objectives", "Objectives", "longtext"),
            col("outcome_summary", "Outcome Summary", "longtext")
        ],
        prepare: async (row) => {
            if (!row.plan_year && row.planned_date) {
                row.plan_year = Number(String(row.planned_date).slice(0, 4));
            }
            return row;
        },
        groups: [
            { title: "By status", expr: a => `${a}.status`, chart: "doughnut" },
            { title: "By drill type", expr: a => `${a}.drill_type`, chart: "bar" },
            { title: "By month planned", expr: monthOf("planned_date"), chart: "line", sort: "label" }
        ]
    },

    meetings: {
        label: "Meetings",
        table: "meetings",
        pk: "meeting_id",
        path: "/meetings",
        viewPath: id => `/meetings/view/${id}`,
        dateCol: "meeting_date",
        findings: true,
        loc: a => `${a}.location`,
        columns: [
            col("title", "Title", "text", { required: true }),
            col("meeting_type", "Meeting Type", "text", { required: true }),
            col("meeting_date", "Meeting Date", "date", { required: true }),
            col("start_time", "Start Time (HH:MM)", "time"),
            col("location", "Location"),
            col("chairperson_id", "Chairperson", "employee"),
            col("agenda", "Agenda", "longtext"),
            col("status", "Status", "text", { default: "Scheduled" })
        ],
        groups: [
            { title: "By status", expr: a => `${a}.status`, chart: "doughnut" },
            { title: "By meeting type", expr: a => `${a}.meeting_type`, chart: "bar" },
            { title: "By month", expr: monthOf("meeting_date"), chart: "line", sort: "label" }
        ]
    },

    employees: {
        label: "Employees",
        table: "employees",
        pk: "employee_id",
        path: "/employees",
        viewPath: id => `/employees/view/${id}`,
        dateCol: "employment_date",
        adminOnly: true,
        loc: a => DEPT_LOC(`${a}.department_id`),
        columns: [
            col("employee_name", "Employee Name", "text", { required: true }),
            col("gender", "Gender"),
            col("phone", "Phone"),
            col("email", "Email"),
            col("job_title", "Job Title"),
            col("department_id", "Department", "department"),
            col("employment_date", "Employment Date", "date"),
            col("status", "Status", "text", { default: "Active" }),
            col("role_id", "Role", "role")
        ],
        groups: [
            { title: "By status", expr: a => `${a}.status`, chart: "doughnut" },
            { title: "By role", expr: a => `COALESCE((SELECT r.role_name FROM roles r WHERE r.role_id = ${a}.role_id), 'No role')`, chart: "bar" },
            { title: "By department", expr: a => `COALESCE((SELECT d.department_name FROM departments d WHERE d.department_id = ${a}.department_id), 'None')`, chart: "bar" }
        ]
    },

    departments: {
        label: "Departments",
        table: "departments",
        pk: "department_id",
        path: "/departments",
        viewPath: id => `/departments/view/${id}`,
        dateCol: null,
        adminOnly: true,
        loc: a => `${a}.location`,
        columns: [
            col("department_name", "Department Name", "text", { required: true }),
            col("location", "Location")
        ],
        groups: [
            { title: "Departments by location", expr: a => `${a}.location`, chart: "bar" }
        ]
    }
};

// Modules that have the findings / root cause / action panel
const FINDING_MODULES = Object.keys(MODULES).filter(k => MODULES[k].findings);


// -----------------------------------------------------
// Helpers
// -----------------------------------------------------

function getModule(key) {
    return MODULES[key] || null;
}

// SQL expression that shows a column as human-readable text (names, not ids).
function displayExpr(column, alias) {

    const c = `${alias}.${column.key}`;

    switch (column.type) {
        case "employee":
            return `(SELECT employee_name FROM employees WHERE employee_id = ${c})`;
        case "department":
            return `(SELECT department_name FROM departments WHERE department_id = ${c})`;
        case "role":
            return `(SELECT role_name FROM roles WHERE role_id = ${c})`;
        default:
            return c;
    }
}

// All columns worth showing in a report (input columns + calculated ones).
function reportColumns(mod) {
    return [...mod.columns, ...(mod.reportExtra || [])];
}

// Reads ?location= from the request and returns a WHERE fragment for the
// module's location, plus the list of locations for the dropdown.
// Also puts `locations` and `location` on res.locals for the view.
async function applyLocation(moduleKey, req, res, alias) {

    const mod = MODULES[moduleKey];
    const expr = mod.loc(alias);

    const [rows] = await db.query(`
        SELECT DISTINCT ${expr} AS loc
        FROM ${mod.table} ${alias}
        HAVING loc IS NOT NULL AND loc <> ''
        ORDER BY loc
    `);

    const locations = rows.map(r => r.loc);
    const selected = String((req.query && req.query.location) || "").trim();

    res.locals.locations = locations;
    res.locals.location = selected;
    res.locals.moduleKey = moduleKey;

    if (!selected) {
        return { clause: "", params: [] };
    }

    return { clause: ` AND ${expr} = ?`, params: [selected] };
}


module.exports = {
    MODULES,
    FINDING_MODULES,
    getModule,
    displayExpr,
    reportColumns,
    applyLocation,
    nextMocNumber,
    levelFor
};
