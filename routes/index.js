const express = require('express');
const router = express.Router();
const db = require('../db'); // Imports your centralized database promise pool setup

// =========================================================================
// READ (Index Landing Page Handler)
// =========================================================================
router.get('/', async (req, res) => {
    try {
        // 1. Concurrent query gathering from operational database tables 
        const [incidentsResult] = await db.query('SELECT COUNT(*) AS total FROM incidents WHERE status = "Open"');
        const [lowStockResult] = await db.query('SELECT COUNT(*) AS total FROM ppe_inventory WHERE quantity_available <= 10');
        const [permitsResult] = await db.query('SELECT COUNT(*) AS total FROM permits WHERE status = "Active" OR status = "Approved"');
        const [employeesResult] = await db.query('SELECT COUNT(*) AS total FROM employees');

        // 2. Safely capture the current session user context if available
        const currentUser = req.session && req.session.user ? req.session.user : null;

        // 3. Render the index template injecting variables requested by the template loop layout
        res.render('index', {
            pageTitle: 'Home',          
            active: 'dashboard',        
            user: currentUser,
            stats: {
                openIncidents: incidentsResult[0]?.total || 0,
                lowPpeItems: lowStockResult[0]?.total || 0,
                activePermits: permitsResult[0]?.total || 0,
                staffCount: employeesResult[0]?.total || 0
            }
        });

    } catch (error) {
        console.error('Error rendering dashboard overview metrics:', error.message);
        
        // Safety fallback rendering to avoid unhandled template exceptions if tables are blank or missing
        res.render('index', {
            pageTitle: 'Home',
            active: 'dashboard',
            user: req.session && req.session.user ? req.session.user : null,
            stats: { 
                openIncidents: 0, 
                lowPpeItems: 0, 
                activePermits: 0, 
                staffCount: 0 
            }
        });
    }
});

module.exports = router;
