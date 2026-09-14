const express = require('express');
const router = express.Router();
const db = require("../db");
// =========================================================================
// 1. CRUD - READ: Render structural confirmation page view with current context
// =========================================================================
router.get('/logout', (req, res) => {
    // Session Guard: If no session profile context exists, direct them back out 
    if (!req.session || !req.session.user) {
        return res.redirect('/login');
    }

    // Renders your specific confirmation template page layout, passing the active profile
    res.render('auth/logout_confirm', { 
        user: {
            name: req.session.user.name || req.session.user.email
        }
    });
});

// =========================================================================
// 2. CRUD - DELETE: Terminate and clear active authentication profile session
// =========================================================================
router.post('/logout', (req, res) => {
    if (!req.session) {
        return res.redirect('/login');
    }

    // Wipe session parameters off the server memory/disk store
    req.session.destroy((err) => {
        if (err) {
            console.error('Critical failure destroying user session scope:', err);
            return res.status(500).send('Error closing session state safely.');
        }

        // Erase cookie mapping context from client's browser architecture 
        res.clearCookie('connect.sid'); 
        
        // Direct the browser seamlessly back to the authentication screen
        res.redirect('/login');
    });
});

// =========================================================================
// 3. CRUD - INDEX (READ ALL): Debug route to view current user's diagnostic profile
// =========================================================================
router.get('/session/status', (req, res) => {
    if (req.session && req.session.user) {
        res.json({
            authenticated: true,
            active_profile: req.session.user,
            session_expiry: req.session.cookie.maxAge
        });
    } else {
        res.json({ authenticated: false, message: "No active session logged." });
    }
});

module.exports = router;
