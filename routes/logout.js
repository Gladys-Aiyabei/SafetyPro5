const express = require("express");
const router = express.Router();


// =====================================================
// LOGOUT
// GET /logout
// =====================================================
router.get("/", (req, res) => {

    req.session.destroy((error) => {

        if (error) {
            console.error("Error destroying session:", error);
        }

        res.redirect("/login");

    });

});


module.exports = router;