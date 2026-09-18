const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");

// Import MySQL database connection/pool
const db = require("../db");


// =====================================================
// 1. SHOW LOGIN FORM
// GET /login
// =====================================================
router.get("/", (req, res) => {

    // If already logged in, skip straight to dashboard
    if (req.session.user) {
        return res.redirect("/");
    }

    res.render("login/index", {
        title: "Login",
        error: null
    });

});


// =====================================================
// 2. HANDLE LOGIN SUBMISSION
// POST /login
// =====================================================
router.post("/", async (req, res) => {

    const { username, password } = req.body;

    if (!username || !password) {
        return res.render("login/index", {
            title: "Login",
            error: "Username/email and password are required."
        });
    }

    try {

        const [users] = await db.query(`
            SELECT *
            FROM users
            WHERE username = ? OR email = ?
        `, [username, username]);

        if (users.length === 0) {
            return res.render("login/index", {
                title: "Login",
                error: "Invalid username or password."
            });
        }

        const user = users[0];

        if (user.status !== "Active") {
            return res.render("login/index", {
                title: "Login",
                error: "This account is inactive. Please contact an administrator."
            });
        }

        const passwordMatches = await bcrypt.compare(password, user.password);

        if (!passwordMatches) {
            return res.render("login/index", {
                title: "Login",
                error: "Invalid username or password."
            });
        }

        // Store minimal, non-sensitive user info in session
        req.session.user = {
            user_id: user.user_id,
            username: user.username,
            email: user.email,
            role: user.role,
            employee_id: user.employee_id
        };

        res.redirect("/");

    } catch (error) {

        console.error("Error during login:", error);

        res.render("login/index", {
            title: "Login",
            error: "An error occurred while logging in. Please try again."
        });
    }
});


module.exports = router;