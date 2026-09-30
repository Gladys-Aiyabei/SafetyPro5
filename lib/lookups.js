// =====================================================
// LOOKUPS shared by the forms
// =====================================================

const db = require("../db");

async function employeesList() {

    const [rows] = await db.query(`
        SELECT employee_id, employee_name
        FROM employees
        WHERE status = 'Active' OR status IS NULL
        ORDER BY employee_name
    `);

    return rows;
}

// Every location already in use (used as suggestions on forms).
async function knownLocations() {

    const [rows] = await db.query(`
        SELECT location FROM departments
        UNION SELECT location FROM incidents
        UNION SELECT location FROM inspections
        UNION SELECT location FROM permits
        UNION SELECT location FROM moc_records
        UNION SELECT location FROM erp_drills
        UNION SELECT location FROM meetings
    `);

    return rows
        .map(r => r.location)
        .filter(l => l && String(l).trim() !== "")
        .sort();
}

// "" -> null, "12" -> 12
function optionalId(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function optionalText(value) {
    const v = String(value == null ? "" : value).trim();
    return v === "" ? null : v;
}

function optionalDate(value) {
    const v = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

module.exports = {
    employeesList,
    knownLocations,
    optionalId,
    optionalText,
    optionalDate
};
