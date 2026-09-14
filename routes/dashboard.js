const express = require('express');
const router = express.Router();
const db = require('../db'); // Adjust this path based on where your db connection file is located

router.get('/', async (req, res) => {
    try {
        // --- 1. Extract query filters from request URL ---
        const { department, location, year, month, status } = req.query;

        // Sensible fallback configuration objects for template looping
        const currentYear = year || new Date().getFullYear();
        const fallbackYears = new Date().getFullYear(); // Dynamic current year

        const monthsArray = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

        // --- 2. Query structural parameters for filters ---
        const [departments] = await db.query('SELECT id, name FROM departments');
        const [locations] = await db.query('SELECT id, name FROM locations');

        // --- 3. Gather Dashboard Data Metrics & KPIs (Mock values tailored to EJS architecture) ---
        // Tip: Replace these literal assignments with your actual parameterized SQL aggregate functions 
        // e.g. COUNT(*), AVG(score) filtered using the inputs fetched above.
        const kpis = {
            activeIncidents: { open: 4, resolved: 12 },
            auditComplianceRate: 92,
            pendingCAPA: { high: 2, medium: 5, low: 3 },
            ppeComplianceRate: 98
        };

        const ratios = {
            ltif: "0.85",
            trcf: "1.20",
            smvir: "0.00",
            rollover: "0"
        };

        // Populate matrix coordinates (likelihood-severity structure) matching '<L>-<S>' template logic
        const riskMatrixData = {
            '5-1': 0, '5-2': 1, '5-3': 0, '5-4': 2, '5-5': 0,
            '4-1': 1, '4-2': 4, '4-3': 1, '4-4': 0, '4-5': 0,
            '3-1': 0, '3-2': 2, '3-3': 8, '3-4': 1, '3-5': 0,
            '2-1': 3, '2-2': 5, '2-3': 2, '2-4': 0, '2-5': 0,
            '1-1': 12, '1-2': 4, '1-3': 1, '1-4': 0, '1-5': 0
        };

        const trainingData = [
            { employeeGroup: 'Logistics', module: 'Defensive Driving', percentage: 88 },
            { employeeGroup: 'Operations', module: 'Lockout-Tagout', percentage: 95 },
            { employeeGroup: 'All Personnel', module: 'Fire Safety & Evacuation', percentage: 74 }
        ];

        // --- 4. Package data payload and render template ---
        res.render('dashboard', {
            departments: departments,
            locations: locations,
            years: fallbackYears,
            months: monthsArray,
            filters: {
                department: department || '',
                location: location || '',
                year: currentYear,
                month: month || 'all',
                status: status || ''
            },
            kpis: kpis,
            ratios: ratios,
            riskMatrixData: riskMatrixData,
            trainingData: trainingData
        });

    } catch (error) {
        console.error("Dashboard routing error:", error);
        res.status(500).send("Error compiling dashboard datasets.");
    }
});


// EXPORT ROUTER
module.exports = router;