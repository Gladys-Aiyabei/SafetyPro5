// =====================================================
// EMAIL (nodemailer)
//
// Settings come from mail.config.js in the project root (copy mail.config.example.js,
// it is git-ignored because it holds the mailbox password). Environment variables
// SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / MAIL_FROM / APP_URL
// override the file.
//
// With no SMTP host configured, emails are printed to the console instead of sent,
// so the app keeps working before email is set up.
// =====================================================

const nodemailer = require("nodemailer");

function loadConfig() {

    let file = {};

    try {
        file = require("../mail.config");
    } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error;
    }

    const env = process.env;

    return {
        host: env.SMTP_HOST || file.host || "",
        port: Number(env.SMTP_PORT || file.port || 587),
        secure: String(env.SMTP_SECURE || file.secure || "false") === "true",
        user: env.SMTP_USER || file.user || "",
        pass: env.SMTP_PASS || file.pass || "",
        from: env.MAIL_FROM || file.from || "SafetyPro <no-reply@localhost>",
        appUrl: String(env.APP_URL || file.appUrl || "http://localhost:3000").replace(/\/+$/, "")
    };
}

const config = loadConfig();

const transport = config.host
    ? nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass } : undefined
    })
    : null;

if (!transport) {
    console.log("Email not configured (no SMTP host): notifications will be logged to the console.");
}

// Full link to a page in the app, e.g. link("/incidents/view/5")
function link(pathname) {
    return config.appUrl + pathname;
}

// { to, subject, text, html } -> resolves when sent (or logged)
async function send(message) {

    if (!transport) {
        const bcc = message.bcc ? ` | Bcc: ${String(message.bcc).split(",").length} recipient(s)` : "";
        const files = (message.attachments || []).map(a => a.filename).join(", ");
        console.log(`[email not sent: SMTP not configured] To: ${message.to}${bcc} | ${message.subject}${files ? ` | Attached: ${files}` : ""}`);
        return;
    }

    await transport.sendMail({ from: config.from, ...message });
}

module.exports = {
    send,
    link,
    fromAddress: config.from,
    configured: Boolean(transport)
};
