// =====================================================
// FORMAT HELPERS (also exposed to every EJS view via app.locals)
// =====================================================

const pad = n => String(n).padStart(2, "0");

function fmtDate(value) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d)) return "";
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(value) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d)) return "";
    return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// CSS-friendly slug: "In Progress" -> "in-progress"
function slug(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Only allow redirects back to a local path.
function safeReturn(value, fallback) {
    const v = String(value || "");
    return v.startsWith("/") && !v.startsWith("//") ? v : fallback;
}

module.exports = { fmtDate, fmtDateTime, slug, safeReturn };
