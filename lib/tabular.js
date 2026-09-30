// =====================================================
// TABULAR FILES
//   parseUpload : read rows from .xlsx / .xls / .csv / .docx (first table or "Label: value" blocks)
//   buildXlsx   : Excel report / template
//   buildDocx   : Word report
//   buildPdf    : PDF report
//
// A "section" is { heading, columns: [...labels], rows: [[...values]] }.
// =====================================================

const path = require("path");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const mammoth = require("mammoth");
const PDFDocument = require("pdfkit");
const {
    Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
    WidthType, HeadingLevel, PageOrientation, ShadingType
} = require("docx");

const GREEN = "29AB87";
const DEEP = "0E4D3A";


// =====================================================
// READING UPLOADS
// =====================================================

function normalise(text) {
    return String(text == null ? "" : text).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function decodeEntities(text) {
    return text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

// Word: pull the largest table out of the document's HTML.
function tablesFromHtml(html) {

    const tables = [];

    for (const table of html.match(/<table[\s\S]*?<\/table>/gi) || []) {

        const rows = [];

        for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {

            const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(cell =>
                decodeEntities(
                    cell.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
                ).trim()
            );

            if (cells.length > 0) rows.push(cells);
        }

        tables.push(rows);
    }

    return tables.sort((a, b) => b.length - a.length);
}

// Word without a table: records written as "Label: value" lines. A new record starts when a
// label repeats (Word puts a blank line between every paragraph, so blank lines mean nothing).
function recordsFromText(text) {

    const records = [];
    let current = {};

    for (const line of text.split(/\r?\n/)) {

        const m = line.match(/^\s*([^:]{1,60}):\s*(.*)$/);

        if (!m) continue;

        const label = m[1].trim();

        if (Object.prototype.hasOwnProperty.call(current, label)) {
            records.push(current);
            current = {};
        }

        current[label] = m[2].trim();
    }

    if (Object.keys(current).length > 0) records.push(current);

    return records;
}

// Returns { headers: [...], rows: [ {header: value} ] }
async function parseUpload(file) {

    const ext = path.extname(file.originalname).toLowerCase();

    if (ext === ".docx") {

        const html = (await mammoth.convertToHtml({ buffer: file.buffer })).value;
        const tables = tablesFromHtml(html);

        if (tables.length > 0 && tables[0].length >= 2) {

            const [head, ...body] = tables[0];

            return {
                headers: head,
                rows: body.map(cells =>
                    Object.fromEntries(head.map((h, i) => [h, cells[i] == null ? "" : cells[i]]))
                )
            };
        }

        const text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
        const records = recordsFromText(text);

        if (records.length === 0) {
            throw new Error("No table or 'Label: value' records were found in the Word document.");
        }

        const headers = [...new Set(records.flatMap(r => Object.keys(r)))];

        return { headers, rows: records };
    }

    // Excel / CSV
    const workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: true });

    const sheetName = workbook.SheetNames.find(n => normalise(n) !== "help") || workbook.SheetNames[0];

    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1, raw: true, defval: "", blankrows: false
    });

    if (grid.length < 2) {
        throw new Error("The file needs a header row and at least one data row.");
    }

    const headers = grid[0].map(h => String(h).trim());

    return {
        headers,
        rows: grid.slice(1).map(cells =>
            Object.fromEntries(headers.map((h, i) => [h, cells[i] == null ? "" : cells[i]]))
        )
    };
}

// Which of a module's columns does each uploaded header refer to?
function mapHeaders(headers, columns) {

    const byName = new Map();

    for (const c of columns) {
        byName.set(normalise(c.key), c);
        byName.set(normalise(c.label), c);
        byName.set(normalise(c.label.replace(/\(.*?\)/g, "")), c);
    }

    const mapping = {};
    const unknown = [];

    for (const h of headers) {
        const c = byName.get(normalise(h));
        if (c) mapping[h] = c; else if (String(h).trim()) unknown.push(h);
    }

    return { mapping, unknown };
}


// =====================================================
// EXCEL OUTPUT
// =====================================================

function shortText(value, max = 32000) {
    const s = value == null ? "" : String(value);
    return s.length > max ? s.slice(0, max) : s;
}

async function buildXlsx({ title, meta, sections }) {

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "SafetyPro";
    workbook.created = new Date();

    for (const [index, section] of sections.entries()) {

        const name = (section.heading || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31);

        const sheet = workbook.addWorksheet(name);

        sheet.addRow([title]).font = { bold: true, size: 14, color: { argb: "FF" + DEEP } };
        sheet.addRow([meta]).font = { italic: true, color: { argb: "FF666666" } };
        sheet.addRow([]);

        const header = sheet.addRow(section.columns);

        header.eachCell(cell => {
            cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + GREEN } };
            cell.alignment = { vertical: "middle", wrapText: true };
        });

        for (const row of section.rows) {
            sheet.addRow(row.map(v => (v instanceof Date ? v : shortText(v))));
        }

        section.columns.forEach((label, i) => {
            const longest = Math.max(
                String(label).length,
                ...section.rows.slice(0, 200).map(r => String(r[i] == null ? "" : r[i]).length)
            );
            sheet.getColumn(i + 1).width = Math.min(60, Math.max(12, longest + 2));
            sheet.getColumn(i + 1).alignment = { vertical: "top", wrapText: true };
        });

        sheet.views = [{ state: "frozen", ySplit: 4 }];
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
}


// =====================================================
// WORD OUTPUT
// =====================================================

async function buildDocx({ title, meta, sections }) {

    const cell = (text, opts = {}) => new TableCell({
        shading: opts.header
            ? { type: ShadingType.CLEAR, fill: GREEN, color: "auto" }
            : undefined,
        children: [new Paragraph({
            children: [new TextRun({
                text: shortText(text, 3000),
                bold: !!opts.header,
                color: opts.header ? "FFFFFF" : undefined,
                size: 16
            })]
        })]
    });

    const children = [
        new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
        new Paragraph({ children: [new TextRun({ text: meta, italics: true, color: "666666" })] }),
        new Paragraph({ text: "" })
    ];

    for (const section of sections) {

        children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_2 }));

        if (section.rows.length === 0) {
            children.push(new Paragraph({ text: "No records." }));
            continue;
        }

        children.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
                new TableRow({
                    tableHeader: true,
                    children: section.columns.map(c => cell(c, { header: true }))
                }),
                ...section.rows.map(r =>
                    new TableRow({
                        children: r.map(v => cell(v instanceof Date ? v.toISOString().slice(0, 10) : v))
                    })
                )
            ]
        }));

        children.push(new Paragraph({ text: "" }));
    }

    const doc = new Document({
        creator: "SafetyPro",
        title,
        sections: [{
            properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } },
            children
        }]
    });

    return Packer.toBuffer(doc);
}


// =====================================================
// PDF OUTPUT
// =====================================================

function drawPdfTable(doc, columns, rows) {

    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;
    const pad = 4;

    const weights = columns.map((label, i) =>
        Math.min(40, Math.max(6, String(label).length,
            ...rows.slice(0, 60).map(r => String(r[i] == null ? "" : r[i]).length)))
    );

    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map(w => (w / total) * usable);

    const bottom = () => doc.page.height - doc.page.margins.bottom;

    const heightOf = (cells, font) => {
        doc.font(font).fontSize(8);
        return Math.max(...cells.map((c, i) =>
            doc.heightOfString(String(c == null ? "" : c), { width: widths[i] - pad * 2 })
        )) + pad * 2;
    };

    const drawRow = (cells, y, height, header) => {

        let x = left;

        cells.forEach((c, i) => {

            if (header) {
                doc.rect(x, y, widths[i], height).fill("#" + GREEN);
            } else {
                doc.rect(x, y, widths[i], height).strokeColor("#D5DEDA").lineWidth(0.5).stroke();
            }

            doc.fillColor(header ? "#FFFFFF" : "#1E2A2A")
                .font(header ? "Helvetica-Bold" : "Helvetica")
                .fontSize(8)
                .text(String(c == null ? "" : c), x + pad, y + pad, { width: widths[i] - pad * 2 });

            x += widths[i];
        });
    };

    let y = doc.y;

    const header = () => {
        const h = heightOf(columns, "Helvetica-Bold");
        if (y + h > bottom()) { doc.addPage(); y = doc.page.margins.top; }
        drawRow(columns, y, h, true);
        y += h;
    };

    header();

    for (const row of rows) {

        const cells = row.map(v => {
            const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? "" : v);
            return s.length > 400 ? s.slice(0, 400) + "..." : s;
        });

        const h = heightOf(cells, "Helvetica");

        if (y + h > bottom()) {
            doc.addPage();
            y = doc.page.margins.top;
            header();
        }

        drawRow(cells, y, h, false);
        y += h;
    }

    doc.y = y + 10;
    doc.x = left;
}

function buildPdf({ title, meta, sections }) {

    return new Promise((resolve, reject) => {

        const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 30 });

        const chunks = [];
        doc.on("data", c => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        doc.font("Helvetica-Bold").fontSize(18).fillColor("#" + DEEP).text(title);
        doc.font("Helvetica-Oblique").fontSize(9).fillColor("#666666").text(meta);
        doc.moveDown(0.8);

        for (const section of sections) {

            if (doc.y > doc.page.height - 100) doc.addPage();

            doc.font("Helvetica-Bold").fontSize(12).fillColor("#" + DEEP).text(section.heading);
            doc.moveDown(0.3);

            if (section.rows.length === 0) {
                doc.font("Helvetica").fontSize(9).fillColor("#666666").text("No records.");
                doc.moveDown();
                continue;
            }

            drawPdfTable(doc, section.columns, section.rows);
        }

        doc.end();
    });
}


module.exports = {
    normalise,
    parseUpload,
    mapHeaders,
    buildXlsx,
    buildDocx,
    buildPdf
};
