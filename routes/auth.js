// =====================================================
// AUTH MIDDLEWARE
// Protects routes that require a logged-in user.
// =====================================================

function requireLogin(req, res, next) {

    if (req.session && req.session.user) {
        return next();
    }

    return res.redirect("/login");

}

module.exports = {
    requireLogin
};
