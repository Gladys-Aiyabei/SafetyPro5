// =====================================================
// FILE UPLOADS
//  - evidenceUpload : action / training evidence, stored on disk in uploads/evidence
//                     (outside /public, so files are only served to logged-in users)
//  - memoryUpload   : bulk-import spreadsheets / Word files, kept in memory
// =====================================================

const path = require("path");
const fs = require("fs");
const multer = require("multer");

const EVIDENCE_DIR = path.join(__dirname, "..", "uploads", "evidence");

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const EVIDENCE_TYPES = [
    ".pdf", ".png", ".jpg", ".jpeg", ".gif",
    ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt"
];

const evidenceUpload = multer({
    storage: multer.diskStorage({
        destination: EVIDENCE_DIR,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            const base = path.basename(file.originalname, ext)
                .replace(/[^a-zA-Z0-9_-]+/g, "_")
                .slice(0, 60);
            cb(null, `${Date.now()}-${base}${ext}`);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, EVIDENCE_TYPES.includes(ext));
    }
});

const IMPORT_TYPES = [".xlsx", ".xls", ".csv", ".docx"];

const memoryUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, IMPORT_TYPES.includes(ext));
    }
});

// Stored value for the DB (just the file name).
function evidenceName(file) {
    return file ? file.filename : null;
}

// Wraps a multer middleware so upload errors become a readable 400.
function handleUpload(middleware) {
    return (req, res, next) => {
        middleware(req, res, (err) => {
            if (!err) return next();
            return res.status(400).send(
                `Upload failed: ${err.code === "LIMIT_FILE_SIZE" ? "file is larger than 10 MB" : err.message}`
            );
        });
    };
}

module.exports = {
    EVIDENCE_DIR,
    evidenceUpload,
    memoryUpload,
    evidenceName,
    handleUpload
};
