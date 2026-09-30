// =====================================================
// USERS  (the accounts that can log in)
// Mounted at /users in app.js behind requireLogin + requireAdmin,
// so only an Admin can list, view, add, edit or delete users.
//
//   GET  /users              list, with search / role / status filters
//   GET  /users/add          new user form
//   POST /users/add
//   GET  /users/view/:id     one user
//   GET  /users/edit/:id     edit form
//   POST /users/edit/:id
//   POST /users/delete/:id
//
// The rules (validation, hashing, self-protection) are in lib/users.js.
// =====================================================

const express = require("express");
const router = express.Router();

const users = require("../lib/users");

const idOf = req => (/^\d+$/.test(String(req.params.id)) ? Number(req.params.id) : 0);


// One-time message shown on the next page (kept in the session across the redirect).
function flash(req, res, result, to = "/users") {
    req.session.usersFlash = { type: result.ok ? "ok" : "error", text: result.message };
    req.session.save(() => res.redirect(to));
}

function takeFlash(req) {
    const message = req.session.usersFlash || null;
    delete req.session.usersFlash;
    return message;
}

async function formData(extra = {}) {
    return {
        employees: await users.employeeChoices(),
        roles: users.ROLES,
        statuses: users.STATUSES,
        error: null,
        editUser: null,
        ...extra
    };
}


// =====================================================
// LIST  GET /users
// =====================================================
router.get("/", async (req, res) => {

    try {

        const filters = {
            q: String(req.query.q || "").trim().slice(0, 100),
            role: users.ROLES.includes(req.query.role) ? req.query.role : "",
            status: users.STATUSES.includes(req.query.status) ? req.query.status : ""
        };

        const rows = await users.listUsers(filters);

        res.render("users/index", {
            title: "Users",
            users: rows,
            filters,
            roles: users.ROLES,
            statuses: users.STATUSES,
            isActive: users.isActive,
            meId: req.session.user.user_id,
            flash: takeFlash(req)
        });

    } catch (error) {
        console.error("Error loading users:", error);
        res.status(500).send("Error loading users");
    }
});


// =====================================================
// ADD  GET / POST /users/add
// =====================================================
router.get("/add", async (req, res) => {

    try {

        res.render("users/form", await formData({
            title: "New User",
            mode: "add",
            recordId: null,
            values: { role: "User", status: "Active" },
            meId: req.session.user.user_id
        }));

    } catch (error) {
        console.error("Error opening the user form:", error);
        res.status(500).send("Error opening the form");
    }
});

router.post("/add", async (req, res) => {

    try {

        const result = await users.createUser(req.body);

        if (result.ok) return flash(req, res, result, `/users/view/${result.id}`);

        res.status(400).render("users/form", await formData({
            title: "New User",
            mode: "add",
            recordId: null,
            values: result.form,
            error: result.message,
            meId: req.session.user.user_id
        }));

    } catch (error) {
        console.error("Error adding user:", error);
        res.status(500).send("Error adding the user");
    }
});


// =====================================================
// VIEW  GET /users/view/:id
// =====================================================
router.get("/view/:id", async (req, res) => {

    try {

        const record = idOf(req) ? await users.getUser(idOf(req)) : null;

        if (!record) return flash(req, res, { ok: false, message: "That user no longer exists." });

        res.render("users/view", {
            title: "User: " + record.username,
            record,
            isActive: users.isActive,
            meId: req.session.user.user_id,
            flash: takeFlash(req)
        });

    } catch (error) {
        console.error("Error loading user:", error);
        res.status(500).send("Error loading the user");
    }
});


// =====================================================
// EDIT  GET / POST /users/edit/:id
// =====================================================
router.get("/edit/:id", async (req, res) => {

    try {

        const record = idOf(req) ? await users.getUser(idOf(req)) : null;

        if (!record) return flash(req, res, { ok: false, message: "That user no longer exists." });

        res.render("users/form", await formData({
            title: "Edit User",
            mode: "edit",
            recordId: record.user_id,
            editUser: record,
            values: record,
            meId: req.session.user.user_id
        }));

    } catch (error) {
        console.error("Error opening the user form:", error);
        res.status(500).send("Error opening the form");
    }
});

router.post("/edit/:id", async (req, res) => {

    try {

        const id = idOf(req);
        const result = await users.updateUser(id, req.body, req.session.user);

        if (result.ok) return flash(req, res, result, `/users/view/${id}`);
        if (result.missing) return flash(req, res, result);

        res.status(400).render("users/form", await formData({
            title: "Edit User",
            mode: "edit",
            recordId: id,
            editUser: await users.getUser(id),
            values: result.form,
            error: result.message,
            meId: req.session.user.user_id
        }));

    } catch (error) {
        console.error("Error updating user:", error);
        res.status(500).send("Error updating the user");
    }
});


// =====================================================
// DELETE  POST /users/delete/:id
// =====================================================
router.post("/delete/:id", async (req, res) => {

    try {

        flash(req, res, await users.deleteUser(idOf(req), req.session.user));

    } catch (error) {
        console.error("Error deleting user:", error);
        res.status(500).send("Error deleting the user");
    }
});


module.exports = router;
