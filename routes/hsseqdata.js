const express = require("express");
const router = express.Router();

// Import MySQL database connection/pool
const db = require("../db");


// =====================================================
// 1. READ ALL HSSEQ DATA RECORDS
// GET /hsseq
// =====================================================
router.get("/", async (req, res) => {
    try {

        const [records] = await db.query(`
            SELECT *
            FROM hsseq_data
            ORDER BY record_year DESC, record_month DESC
        `);

        res.render("hsseqdata/index", {
            records: records,
            title: "HSSEQ Data"
        });

    } catch (error) {

        console.error("Error fetching HSSEQ data:", error);

        res.status(500).send("Error loading HSSEQ data");
    }
});


// =====================================================
// 2. SHOW ADD RECORD FORM
// GET /hsseq/add
// =====================================================
router.get("/add", (req, res) => {

    res.render("hsseqdata/add", {
        title: "Add HSSEQ Record"
    });

});


// =====================================================
// 3. CREATE RECORD
// POST /hsseq/add
// =====================================================
router.post("/add", async (req, res) => {

    const {
        record_month,
        record_year,
        hazardous_waste_tonnes,
        non_hazardous_waste_tonnes,
        water_consumption_m3,
        exposure_hours_contractors,
        exposure_hours_staff,
        kms_light_vehicles,
        kms_heavy_goods_vehicles,
        ghg_emissions_tonnes,
        attachment_path,
        file_type
    } = req.body;

    if (!record_month || !record_year) {
        return res.status(400).send("Record month and year are required.");
    }

    try {

        await db.query(`
            INSERT INTO hsseq_data
                (record_month, record_year, hazardous_waste_tonnes,
                 non_hazardous_waste_tonnes, water_consumption_m3,
                 exposure_hours_contractors, exposure_hours_staff,
                 kms_light_vehicles, kms_heavy_goods_vehicles,
                 ghg_emissions_tonnes, attachment_path, file_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            record_month,
            record_year,
            hazardous_waste_tonnes || 0,
            non_hazardous_waste_tonnes || 0,
            water_consumption_m3 || 0,
            exposure_hours_contractors || 0,
            exposure_hours_staff || 0,
            kms_light_vehicles || 0,
            kms_heavy_goods_vehicles || 0,
            ghg_emissions_tonnes || 0,
            attachment_path || null,
            file_type || null
        ]);

        res.redirect("/hsseq");

    } catch (error) {

        console.error("Error creating HSSEQ record:", error);

        res.status(500).send(`Error creating HSSEQ record: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 4. VIEW ONE RECORD
// GET /hsseq/view/:id
// =====================================================
router.get("/view/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [records] = await db.query(`
            SELECT *
            FROM hsseq_data
            WHERE hsseq_id = ?
        `, [id]);

        if (records.length === 0) {
            return res.status(404).send("Record not found");
        }

        res.render("hsseqdata/view", {
            record: records[0],
            title: "View HSSEQ Record"
        });

    } catch (error) {

        console.error("Error viewing HSSEQ record:", error);

        res.status(500).send("Error viewing HSSEQ record");
    }
});


// =====================================================
// 5. SHOW EDIT RECORD FORM
// GET /hsseq/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [records] = await db.query(`
            SELECT *
            FROM hsseq_data
            WHERE hsseq_id = ?
        `, [id]);

        if (records.length === 0) {
            return res.status(404).send("Record not found");
        }

        res.render("hsseqdata/edit", {
            record: records[0],
            title: "Edit HSSEQ Record"
        });

    } catch (error) {

        console.error("Error loading edit HSSEQ page:", error);

        res.status(500).send("Error loading edit HSSEQ page");
    }
});


// =====================================================
// 6. UPDATE RECORD
// POST /hsseq/edit/:id
// =====================================================
router.post("/edit/:id", async (req, res) => {

    const { id } = req.params;

    const {
        record_month,
        record_year,
        hazardous_waste_tonnes,
        non_hazardous_waste_tonnes,
        water_consumption_m3,
        exposure_hours_contractors,
        exposure_hours_staff,
        kms_light_vehicles,
        kms_heavy_goods_vehicles,
        ghg_emissions_tonnes,
        attachment_path,
        file_type
    } = req.body;

    if (!record_month || !record_year) {
        return res.status(400).send("Record month and year are required.");
    }

    try {

        const [result] = await db.query(`
            UPDATE hsseq_data
            SET
                record_month = ?,
                record_year = ?,
                hazardous_waste_tonnes = ?,
                non_hazardous_waste_tonnes = ?,
                water_consumption_m3 = ?,
                exposure_hours_contractors = ?,
                exposure_hours_staff = ?,
                kms_light_vehicles = ?,
                kms_heavy_goods_vehicles = ?,
                ghg_emissions_tonnes = ?,
                attachment_path = ?,
                file_type = ?
            WHERE hsseq_id = ?
        `, [
            record_month,
            record_year,
            hazardous_waste_tonnes || 0,
            non_hazardous_waste_tonnes || 0,
            water_consumption_m3 || 0,
            exposure_hours_contractors || 0,
            exposure_hours_staff || 0,
            kms_light_vehicles || 0,
            kms_heavy_goods_vehicles || 0,
            ghg_emissions_tonnes || 0,
            attachment_path || null,
            file_type || null,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Record not found");
        }

        res.redirect("/hsseq");

    } catch (error) {

        console.error("Error updating HSSEQ record:", error);

        res.status(500).send(`Error updating HSSEQ record: ${error.sqlMessage || error.message}`);
    }
});


// =====================================================
// 7. DELETE RECORD
// POST /hsseq/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    const { id } = req.params;

    try {

        const [result] = await db.query(`
            DELETE FROM hsseq_data
            WHERE hsseq_id = ?
        `, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).send("Record not found");
        }

        res.redirect("/hsseq");

    } catch (error) {

        console.error("Error deleting HSSEQ record:", error);

        res.status(500).send("Error deleting HSSEQ record");
    }
});


module.exports = router;