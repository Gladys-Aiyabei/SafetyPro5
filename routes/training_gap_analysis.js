const express = require("express");
const router = express.Router();

const db = require("../db");

const TABLE = "training_requirements";

// ==========================================
// GET ROLES
// ==========================================

async function fetchRolesSafely() {
    try {
        const [roles] = await db.query(
            "SELECT * FROM roles ORDER BY role_id"
        );

        return roles;
    } catch (err) {
        console.log("Roles table not available:", err.message);
        return [];
    }
}

// ==========================================
// RENDER PAGE
// ==========================================

async function renderPage(res, options = {}) {
    const {
        flash = null,
        error = null
    } = options;

    const [requirements] = await db.query(
        `
        SELECT *
        FROM ${TABLE}
        ORDER BY role_id, requirement_id
        `
    );

    const roles = await fetchRolesSafely();

    res.render(
        "training_gap_analysis",
        {
            requirements,
            roles,
            flash,
            error
        }
    );
}

// ==========================================
// DATABASE ERROR MESSAGE
// ==========================================

function friendlyDbError(err) {

    console.error(err);

    if (
        err.code === "ER_NO_REFERENCED_ROW_2" ||
        err.errno === 1452
    ) {
        return "That role does not exist.";
    }

    if (err.code === "ER_DUP_ENTRY") {
        return "That training requirement already exists.";
    }

    if (err.code === "ER_BAD_NULL_ERROR") {
        return "A required field is missing.";
    }

    return "Could not save the training requirement.";
}

// ==========================================
// GET
// /training_gap_analysis
// ==========================================

router.get("/", async (req, res) => {

    try {

        await renderPage(res);

    } catch (err) {

        console.error(
            "Error loading training requirements:",
            err
        );

        res.status(500).render(
            "training_gap_analysis",
            {
                requirements: [],
                roles: [],
                flash: null,
                error:
                    "Could not load training requirements."
            }
        );
    }
});

// ==========================================
// CREATE
// POST /training_gap_analysis
// ==========================================

router.post("/", async (req, res) => {

    const {
        role_id,
        required_training,
        validity_months
    } = req.body;

    if (!role_id || !required_training) {

        try {

            await renderPage(res, {
                error:
                    "Role and required training are required."
            });

        } catch (err) {

            res.status(500).send(
                "Database error."
            );
        }

        return;
    }

    try {

        await db.query(
            `
            INSERT INTO ${TABLE}
            (
                role_id,
                required_training,
                validity_months
            )
            VALUES (?, ?, ?)
            `,
            [
                role_id,
                required_training,
                validity_months || 12
            ]
        );

        res.redirect(
            "/training_gap_analysis"
        );

    } catch (err) {

        console.error(
            "Error creating requirement:",
            err
        );

        try {

            await renderPage(res, {
                error: friendlyDbError(err)
            });

        } catch (renderError) {

            res.status(500).send(
                "Could not save training requirement."
            );
        }
    }
});

// ==========================================
// UPDATE
// POST /training_gap_analysis/:id/update
// ==========================================

router.post("/:id/update", async (req, res) => {

    const { id } = req.params;

    const {
        role_id,
        required_training,
        validity_months
    } = req.body;

    if (!role_id || !required_training) {

        try {

            await renderPage(res, {
                error:
                    "Role and required training are required."
            });

        } catch (err) {

            res.status(500).send(
                "Database error."
            );
        }

        return;
    }

    try {

        await db.query(
            `
            UPDATE ${TABLE}
            SET
                role_id = ?,
                required_training = ?,
                validity_months = ?
            WHERE requirement_id = ?
            `,
            [
                role_id,
                required_training,
                validity_months || 12,
                id
            ]
        );

        res.redirect(
            "/training_gap_analysis"
        );

    } catch (err) {

        console.error(
            "Error updating requirement:",
            err
        );

        try {

            await renderPage(res, {
                error:
                    "Could not update training requirement."
            });

        } catch (renderError) {

            res.status(500).send(
                "Could not update training requirement."
            );
        }
    }
});

// ==========================================
// DELETE
// POST /training_gap_analysis/:id/delete
// ==========================================

router.post("/:id/delete", async (req, res) => {

    const { id } = req.params;

    try {

        await db.query(
            `
            DELETE FROM ${TABLE}
            WHERE requirement_id = ?
            `,
            [id]
        );

        res.redirect(
            "/training_gap_analysis"
        );

    } catch (err) {

        console.error(
            "Error deleting requirement:",
            err
        );

        res.status(500).send(
            "Could not delete training requirement."
        );
    }
});

module.exports = router;
