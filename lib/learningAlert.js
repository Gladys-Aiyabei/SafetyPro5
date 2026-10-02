// =====================================================
// LEARNING ALERT (PDF)
// A one-page summary of a signed-off incident: title, location, short description,
// learnings, rating and pictures. Emailed to every active user when the Head of
// Safety signs the incident off, and downloadable from the incident page.
// =====================================================

const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");

const db = require("../db");
const mailer = require("./mailer");
const { rating } = require("./incidentRating");

const PHOTO_DIR = path.join(__dirname, "..", "uploads", "incidents");

// pdfkit can embed only JPEG and PNG.
const PDF_IMAGE_TYPES = [".jpg", ".jpeg", ".png"];
const MAX_PICTURES = 4;
const MAX_DESCRIPTION = 600;

// Emails go out Bcc in batches so recipients do not see each other.
const BCC_BATCH = 50;

const GREEN = "#29AB87";
const DEEP = "#0E4D3A";
const MUTED = "#666666";

const short = (v, max) => {
    const s = String(v || "").trim();
    return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
};

function alertTitle(incident) {
    const what = incident.classification || incident.incident_type || "Incident";
    return incident.location ? `${what} at ${incident.location}` : what;
}

async function loadIncident(incidentId) {

    const [rows] = await db.query(`
        SELECT i.*, so.employee_name AS signed_off_by_name
        FROM incidents i
        LEFT JOIN employees so ON so.employee_id = i.signed_off_by
        WHERE i.incident_id = ?
    `, [incidentId]);

    if (rows.length === 0) return null;

    const [photos] = await db.query(
        "SELECT file_path, caption FROM incident_images WHERE incident_id = ? ORDER BY image_id",
        [incidentId]
    );

    return { ...rows[0], photos };
}


// =====================================================
// PDF
// =====================================================

function heading(doc, text) {
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(12).fillColor(DEEP).text(text.toUpperCase(), { characterSpacing: 0.5 });
    doc.moveDown(0.25);
}

function renderPdf(incident) {

    return new Promise((resolve, reject) => {

        const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Learning Alert - ${alertTitle(incident)}` } });
        const chunks = [];
        doc.on("data", c => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const left = doc.page.margins.left;
        const width = doc.page.width - left - doc.page.margins.right;
        const r = rating(incident);
        const fmt = d => (d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");

        // Header band
        doc.rect(0, 0, doc.page.width, 78).fill(DEEP);
        doc.rect(0, 78, doc.page.width, 5).fill(GREEN);
        doc.font("Helvetica-Bold").fontSize(24).fillColor("#FFFFFF").text("LEARNING ALERT", left, 22);
        doc.font("Helvetica").fontSize(9).fillColor("#D9F2E9")
            .text(`SafetyPro  ·  Incident #${incident.incident_id}  ·  Issued ${fmt(incident.signed_off_at)}`, left, 52);

        // Title
        doc.y = 100;
        doc.x = left;
        doc.font("Helvetica-Bold").fontSize(17).fillColor("#1E2A2A").text(alertTitle(incident), { width });

        // Key facts
        doc.moveDown(0.5);
        const facts = [
            ["Date", fmt(incident.incident_date)],
            ["Location", incident.location || "-"],
            ["Classification", incident.classification || "-"]
        ];
        const colW = width / 4;
        const factsY = doc.y;

        facts.forEach(([label, value], i) => {
            const x = left + i * colW;
            doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, factsY, { width: colW - 8 });
            doc.font("Helvetica-Bold").fontSize(10).fillColor("#1E2A2A").text(value, x, factsY + 11, { width: colW - 8 });
        });

        // Rating pill
        const rx = left + 3 * colW;
        doc.font("Helvetica").fontSize(8).fillColor(MUTED).text("RATING", rx, factsY, { width: colW });
        if (r) {
            const label = `${r.band} (${r.score})`;
            doc.font("Helvetica-Bold").fontSize(10);
            const pillW = doc.widthOfString(label) + 16;
            doc.roundedRect(rx, factsY + 10, pillW, 16, 8).fill(r.colour);
            doc.fillColor(r.band === "Medium" ? "#000000" : "#FFFFFF").text(label, rx + 8, factsY + 13.5, { lineBreak: false });
            doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
                .text(`${r.likelihood} × ${r.consequence}`, rx, factsY + 30, { width: colW });
        } else {
            doc.font("Helvetica-Bold").fontSize(10).fillColor("#1E2A2A").text("Not rated", rx, factsY + 11);
        }

        doc.x = left;
        doc.y = factsY + 46;
        doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor("#D5DEDA").lineWidth(0.7).stroke();

        // What happened
        heading(doc, "What happened");
        doc.font("Helvetica").fontSize(10.5).fillColor("#1E2A2A")
            .text(short(incident.description, MAX_DESCRIPTION) || "No description recorded.", { width, lineGap: 2 });

        // Learnings (highlighted box)
        heading(doc, "Key learnings");
        const learnings = short(incident.learnings, 900) || "No learnings recorded.";
        doc.font("Helvetica").fontSize(10.5);
        const boxH = doc.heightOfString(learnings, { width: width - 24, lineGap: 2 }) + 18;
        const boxY = doc.y;
        doc.rect(left, boxY, width, boxH).fill("#EEF8F4");
        doc.rect(left, boxY, 4, boxH).fill(GREEN);
        doc.fillColor("#1E2A2A").text(learnings, left + 14, boxY + 9, { width: width - 24, lineGap: 2 });
        doc.x = left;
        doc.y = boxY + boxH;

        // Pictures
        const pictures = incident.photos
            .filter(p => PDF_IMAGE_TYPES.includes(path.extname(p.file_path).toLowerCase()))
            .map(p => ({ ...p, full: path.join(PHOTO_DIR, path.basename(p.file_path)) }))
            .filter(p => fs.existsSync(p.full))
            .slice(0, MAX_PICTURES);

        if (pictures.length) {

            heading(doc, "Pictures");

            const gap = 12;
            const picW = (width - gap) / 2;
            const picH = 150;
            const bottom = doc.page.height - doc.page.margins.bottom - 30;

            let rowY = doc.y;

            pictures.forEach((p, i) => {

                const col = i % 2;

                if (col === 0) {
                    if (rowY + picH + 14 > bottom) {
                        doc.addPage();
                        rowY = doc.page.margins.top;
                    }
                }

                const x = left + col * (picW + gap);
                const y = rowY;

                try {
                    doc.image(p.full, x, y, { fit: [picW, picH], align: "center", valign: "center" });
                } catch (error) {
                    doc.rect(x, y, picW, picH).strokeColor("#D5DEDA").stroke();
                }

                if (p.caption) {
                    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
                        .text(short(p.caption, 80), x, y + picH + 2, { width: picW, align: "center" });
                }

                if (col === 1 || i === pictures.length - 1) {
                    rowY = y + picH + 16;
                    doc.x = left;
                    doc.y = rowY;
                }
            });
        }

        // Footer
        const footY = doc.page.height - doc.page.margins.bottom - 14;
        doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(
            `Signed off by ${incident.signed_off_by_name || "Head of Safety"} (Head of Safety) on ${fmt(incident.signed_off_at)}.  ` +
            "Share these learnings with your team.",
            left, footY, { width, align: "center", lineBreak: false }
        );

        doc.end();
    });
}

// incidentId -> { buffer, filename, incident } or null
async function buildLearningAlert(incidentId) {

    const incident = await loadIncident(incidentId);

    if (!incident) return null;

    const buffer = await renderPdf(incident);
    const filename = `Learning-Alert-Incident-${incident.incident_id}.pdf`;

    return { buffer, filename, incident };
}


// =====================================================
// DISTRIBUTION (all active users)
// =====================================================

const esc = v => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Never throws: problems are logged and must not undo the sign-off.
async function distributeLearningAlert(incidentId) {

    try {
        const alert = await buildLearningAlert(incidentId);

        if (!alert) return;

        const [users] = await db.query(`
            SELECT DISTINCT email
            FROM users
            WHERE LOWER(TRIM(COALESCE(status, ''))) = 'active'
              AND email LIKE '%@%'
        `);

        const emails = users.map(u => u.email.trim());

        if (emails.length === 0) {
            console.log(`Learning alert #${incidentId}: no active users with an email address.`);
            return;
        }

        const { incident } = alert;
        const title = alertTitle(incident);
        const r = rating(incident);
        const url = mailer.link(`/incidents/view/${incident.incident_id}`);

        const html = `
            <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:620px">
                <h2 style="color:${DEEP};margin-bottom:4px">Learning Alert</h2>
                <p style="margin-top:0;font-size:16px"><strong>${esc(title)}</strong></p>
                <p>${esc(short(incident.description, 300))}</p>
                ${r ? `<p>Rating: <strong>${esc(r.band)} (${r.score})</strong></p>` : ""}
                <p>The learning alert is attached as a PDF. Please read it and share the learnings with your team.</p>
                <p style="color:#777;font-size:12px">Incident #${incident.incident_id}: ${esc(url)}</p>
            </div>`;

        const text = [
            "Learning Alert",
            title,
            "",
            short(incident.description, 300),
            r ? `Rating: ${r.band} (${r.score})` : "",
            "",
            "The learning alert is attached as a PDF. Please read it and share the learnings with your team.",
            `Incident #${incident.incident_id}: ${url}`
        ].join("\n");

        let sent = 0;

        for (let i = 0; i < emails.length; i += BCC_BATCH) {

            const batch = emails.slice(i, i + BCC_BATCH);

            try {
                await mailer.send({
                    to: mailer.fromAddress,
                    bcc: batch.join(", "),
                    subject: `Learning Alert: ${title}`,
                    text,
                    html,
                    attachments: [{ filename: alert.filename, content: alert.buffer, contentType: "application/pdf" }]
                });
                sent += batch.length;
            } catch (error) {
                console.error(`Learning alert #${incidentId}: batch email failed:`, error.message);
            }
        }

        console.log(`Learning alert #${incidentId}: ${mailer.configured ? "sent" : "logged"} for ${sent} of ${emails.length} user(s).`);

    } catch (error) {
        console.error(`Learning alert #${incidentId} failed:`, error.message);
    }
}

module.exports = { buildLearningAlert, distributeLearningAlert, alertTitle, renderPdf };
