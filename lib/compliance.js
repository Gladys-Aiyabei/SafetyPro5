// =====================================================
// TRAINING COMPLIANCE
//
//  - Each ROLE has required trainings (role_training_requirements).
//  - Every active employee with a role is assessed against them:
//      Valid              endorsed by the line manager and not expired
//      Pending endorsement  recorded, waiting for the line manager
//      Expired            was valid, expiry date has passed
//      Missing            no record at all
//  - An employee is "Fully trained" only when every requirement is Valid.
// =====================================================

const db = require("../db");

function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

function addMonths(date, months) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
}

// A training record satisfies a requirement when its name contains the requirement name
// (so "Fire Safety Training" satisfies "Fire Safety").
function matches(recordName, requirementName) {
    return String(recordName || "").toLowerCase().includes(String(requirementName || "").toLowerCase());
}

function statusOf(record, requirement, today) {

    if (!record.endorsed_at) return "Pending endorsement";

    let expires = record.expiry_date ? new Date(record.expiry_date) : null;

    if (!expires && requirement.validity_months && record.training_date) {
        expires = addMonths(record.training_date, requirement.validity_months);
    }

    if (expires && expires < today) return "Expired";

    return "Valid";
}

const RANK = { "Valid": 3, "Pending endorsement": 2, "Expired": 1, "Missing": 0 };

// Filters: role_id, department_id, location (all optional)
async function computeCompliance(filters = {}) {

    const today = startOfToday();

    const where = ["e.status = 'Active'", "e.role_id IS NOT NULL"];
    const params = [];

    if (filters.role_id) { where.push("e.role_id = ?"); params.push(filters.role_id); }
    if (filters.department_id) { where.push("e.department_id = ?"); params.push(filters.department_id); }
    if (filters.employee_id) { where.push("e.employee_id = ?"); params.push(filters.employee_id); }
    if (filters.location) {
        where.push("(SELECT d.location FROM departments d WHERE d.department_id = e.department_id LIMIT 1) = ?");
        params.push(filters.location);
    }

    const [employees] = await db.query(`
        SELECT e.employee_id, e.employee_name, e.job_title, e.role_id, e.department_id,
               r.role_name, d.department_name, d.location
        FROM employees e
        LEFT JOIN roles r ON r.role_id = e.role_id
        LEFT JOIN departments d ON d.department_id = e.department_id
        WHERE ${where.join(" AND ")}
        ORDER BY r.role_name, e.employee_name
    `, params);

    const [requirements] = await db.query(`
        SELECT role_id, required_training AS training_name, validity_months
        FROM role_training_requirements
        ORDER BY required_training
    `);

    const ids = employees.map(e => e.employee_id);

    let records = [];

    if (ids.length > 0) {
        [records] = await db.query(`
            SELECT training_id, employee_id, training_name, training_date, expiry_date, endorsed_at
            FROM training
            WHERE employee_id IN (?) AND COALESCE(status, '') NOT IN ('Cancelled', 'Failed')
            ORDER BY training_date DESC
        `, [ids]);
    }

    const rows = employees.map(emp => {

        const required = requirements.filter(r => r.role_id === emp.role_id);
        const mine = records.filter(r => r.employee_id === emp.employee_id);

        const items = required.map(req => {

            let best = { status: "Missing", record: null };

            for (const rec of mine.filter(r => matches(r.training_name, req.training_name))) {
                const status = statusOf(rec, req, today);
                if (RANK[status] > RANK[best.status]) best = { status, record: rec };
            }

            return {
                training: req.training_name,
                status: best.status,
                trainedOn: best.record ? best.record.training_date : null
            };
        });

        const gaps = items.filter(i => i.status !== "Valid");

        return {
            ...emp,
            items,
            gapCount: gaps.length,
            overall: items.length === 0
                ? "No requirements"
                : gaps.length === 0 ? "Fully trained" : "Gap"
        };
    });

    return {
        rows,
        summary: {
            employees: rows.length,
            fully: rows.filter(r => r.overall === "Fully trained").length,
            gaps: rows.filter(r => r.overall === "Gap").length,
            noRequirements: rows.filter(r => r.overall === "No requirements").length
        }
    };
}

// Employees without a role cannot be assessed.
async function employeesWithoutRole() {

    const [rows] = await db.query(`
        SELECT e.employee_id, e.employee_name, e.job_title, d.department_name
        FROM employees e
        LEFT JOIN departments d ON d.department_id = e.department_id
        WHERE e.status = 'Active' AND e.role_id IS NULL
        ORDER BY e.employee_name
    `);

    return rows;
}

// Implementation status of the annual training plan.
async function planProgress(year) {

    const today = startOfToday();

    const [plans] = await db.query(`
        SELECT p.*, r.role_name
        FROM annual_training_plans p
        LEFT JOIN roles r ON r.role_id = p.role_id
        WHERE p.plan_year = ?
        ORDER BY p.target_month, p.training_name
    `, [year]);

    const [staff] = await db.query(`
        SELECT employee_id, role_id FROM employees
        WHERE status = 'Active' AND role_id IS NOT NULL
    `);

    const [records] = await db.query(`
        SELECT employee_id, training_name, training_date, expiry_date, endorsed_at
        FROM training
        WHERE YEAR(training_date) = ? AND endorsed_at IS NOT NULL
          AND COALESCE(status, '') NOT IN ('Cancelled', 'Failed')
    `, [year]);

    return plans.map(plan => {

        const target = staff.filter(s => s.role_id === plan.role_id);

        const trainedIds = new Set(
            records
                .filter(r => matches(r.training_name, plan.training_name) &&
                    (!r.expiry_date || new Date(r.expiry_date) >= today))
                .map(r => r.employee_id)
        );

        const trained = target.filter(s => trainedIds.has(s.employee_id)).length;

        const monthEnd = new Date(year, plan.target_month || 12, 0);

        let implementation = "Planned";

        if (plan.status === "Cancelled") implementation = "Cancelled";
        else if (target.length > 0 && trained === target.length) implementation = "Completed";
        else if (trained > 0) implementation = "In Progress";
        else if (monthEnd < today) implementation = "Overdue";

        return {
            ...plan,
            required: target.length,
            trained,
            pct: target.length ? Math.round((trained / target.length) * 100) : 0,
            implementation
        };
    });
}

module.exports = { computeCompliance, employeesWithoutRole, planProgress, matches };
