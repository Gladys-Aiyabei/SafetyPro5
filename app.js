// =====================================================
// SAFETYPRO5 - MAIN APPLICATION
// =====================================================

const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();


// =====================================================
// DATABASE
// =====================================================

const db = require("./db");


// =====================================================
// AUTHENTICATION MIDDLEWARE
// =====================================================

function requireLogin(req, res, next) {

    // User is logged in
    if (req.session && req.session.user) {
        return next();
    }

    // User is NOT logged in
    console.log(
        `AUTHENTICATION REQUIRED: ${req.method} ${req.originalUrl}`
    );

    return res.redirect("/login");
}


// =====================================================
// ROUTES
// =====================================================

const indexRoutes = require("./routes/index");
const trainingGapRoutes = require("./routes/training_gap_analysis");
const auditsRoutes = require("./routes/audits");
const dashboardRoutes = require("./routes/dashboard");
const departmentRoutes = require("./routes/department");
const documentsRoutes = require("./routes/documents");
const employeesRoutes = require("./routes/employees");
const hsseqdataRoutes = require("./routes/hsseqdata");
const incidentsRoutes = require("./routes/incidents");
const inspectionsRoutes = require("./routes/inspections");
const ppeRoutes = require("./routes/ppe");
const riskRoutes = require("./routes/risk_assesments");
const permitsRoutes = require("./routes/permits");
const findingsRoutes = require("./routes/findings");
const mocRoutes = require("./routes/moc");
const erpRoutes = require("./routes/erp");
const meetingsRoutes = require("./routes/meetings");
const trainingRoutes = require("./routes/training");
const toolsRoutes = require("./routes/tools");
const checklistRoutes = require("./routes/checklists");
const usersRoutes = require("./routes/users");

const { guard, requireAdmin } = require("./lib/access");
const { fmtDate, fmtDateTime, slug } = require("./lib/format");


// =====================================================
// VIEW ENGINE
// =====================================================

app.set("view engine", "ejs");

// Helpers available in every EJS view
app.locals.fmtDate = fmtDate;
app.locals.fmtDateTime = fmtDateTime;
app.locals.slug = slug;

app.set(
    "views",
    path.join(__dirname, "views")
);


// =====================================================
// MIDDLEWARE
// =====================================================

// Serve static files from public folder
app.use(
    express.static(
        path.join(__dirname, "public")
    )
);


// =====================================================
// SESSION
// =====================================================

app.use(
    session({
        secret: "Gla1985,",
        resave: false,
        saveUninitialized: false,

        cookie: {
            secure: false,
            maxAge: 1000 * 60 * 60 * 8
        }
    })
);


// =====================================================
// MAKE LOGGED-IN USER AVAILABLE TO ALL EJS PAGES
// =====================================================

app.use((req, res, next) => {

    res.locals.user = req.session.user || null;

    // Which top-nav item is highlighted
    res.locals.navPath = req.path;

    // Safe defaults; guard() overrides these for module routes
    res.locals.can = { add: false, edit: false, delete: false };
    res.locals.locations = [];
    res.locals.location = "";
    res.locals.trainingNotice = null;

    next();
});


// =====================================================
// PARSE FORM DATA
// =====================================================

app.use(
    express.urlencoded({
        extended: true
    })
);


// =====================================================
// PARSE JSON
// =====================================================

app.use(express.json());


// =====================================================
// LOGIN PAGE
// PUBLIC ROUTE
// =====================================================

// GET /login
app.get("/login", (req, res) => {

    // If already logged in, go to home
    if (req.session && req.session.user) {
        return res.redirect("/");
    }

    res.render("login", {
        title: "Login",
        error: null
    });

});


// =====================================================
// PROCESS LOGIN
// PUBLIC ROUTE
// =====================================================

// POST /login
app.post("/login", async (req, res) => {

    try {

        console.log("");
        console.log("==========================================");
        console.log("LOGIN ATTEMPT");
        console.log("==========================================");


        // ------------------------------------------
        // GET FORM DATA
        // ------------------------------------------

        const email = String(req.body.email || "")
            .trim()
            .toLowerCase();

        const password = String(req.body.password || "");


        console.log("Email submitted:", email);
        console.log(
            "Password supplied:",
            password ? "YES" : "NO"
        );


        // ------------------------------------------
        // VALIDATE INPUT
        // ------------------------------------------

        if (!email || !password) {

            console.log(
                "LOGIN FAILED: Missing email or password"
            );

            return res.render("login", {
                title: "Login",
                error:
                    "Please enter your email and password."
            });

        }


        // ------------------------------------------
        // FIND USER
        // ------------------------------------------

        console.log("Searching users table...");

        const [users] = await db.query(
            `
            SELECT
                user_id,
                username,
                email,
                password,
                role,
                employee_id,
                status
            FROM users
            WHERE LOWER(TRIM(email)) = ?
            LIMIT 1
            `,
            [email]
        );


        console.log(
            "Users found:",
            users.length
        );


        // ------------------------------------------
        // USER NOT FOUND
        // ------------------------------------------

        if (users.length === 0) {

            console.log(
                "LOGIN FAILED: User not found"
            );

            return res.render("login", {
                title: "Login",
                error:
                    "Invalid email or password."
            });

        }


        const user = users[0];


        // ------------------------------------------
        // DISPLAY USER INFORMATION
        // ------------------------------------------

        console.log("User found:");
        console.log("  ID:", user.user_id);
        console.log("  Username:", user.username);
        console.log("  Email:", user.email);
        console.log("  Role:", user.role);
        console.log("  Employee ID:", user.employee_id);
        console.log("  Status:", user.status);


        // ------------------------------------------
        // CHECK PASSWORD FIELD
        // ------------------------------------------

        if (!user.password) {

            console.log(
                "LOGIN FAILED: Password field is empty"
            );

            return res.render("login", {
                title: "Login",
                error:
                    "This account does not have a valid password configured."
            });

        }


        // ------------------------------------------
        // CHECK WHETHER PASSWORD IS BCRYPT
        // ------------------------------------------

        const isBcryptHash =
            typeof user.password === "string" &&
            (
                user.password.startsWith("$2a$") ||
                user.password.startsWith("$2b$") ||
                user.password.startsWith("$2y$")
            );


        console.log(
            "Password format:",
            isBcryptHash
                ? "BCRYPT HASH"
                : "NOT BCRYPT"
        );


        if (!isBcryptHash) {

            console.log(
                "LOGIN FAILED: Password in database is not a bcrypt hash"
            );

            return res.render("login", {
                title: "Login",
                error:
                    "Your account password is not configured correctly. Please contact the administrator."
            });

        }


        // ------------------------------------------
        // CHECK ACCOUNT STATUS
        // ------------------------------------------

        if (
            user.status &&
            String(user.status)
                .trim()
                .toLowerCase() !== "active"
        ) {

            console.log(
                "LOGIN FAILED: Account status is:",
                user.status
            );

            return res.render("login", {
                title: "Login",
                error:
                    "Your account is inactive. Please contact your site administrator."
            });

        }


        // ------------------------------------------
        // VERIFY PASSWORD
        // ------------------------------------------

        console.log("Checking password...");

        const passwordMatch =
            await bcrypt.compare(
                password,
                user.password
            );


        console.log(
            "Password match:",
            passwordMatch
        );


        if (!passwordMatch) {

            console.log(
                "LOGIN FAILED: Incorrect password"
            );

            return res.render("login", {
                title: "Login",
                error:
                    "Invalid email or password."
            });

        }


        // ------------------------------------------
        // CREATE SESSION
        // ------------------------------------------

        req.session.user = {

            user_id: user.user_id,

            username: user.username,

            email: user.email,

            role: user.role,

            employee_id: user.employee_id,

            status: user.status

        };


        console.log(
            "Session user created"
        );


        // ------------------------------------------
        // SAVE SESSION BEFORE REDIRECT
        // ------------------------------------------

        req.session.save((err) => {

            if (err) {

                console.error(
                    "SESSION SAVE ERROR:",
                    err
                );

                return res.status(500).render(
                    "login",
                    {
                        title: "Login",
                        error:
                            "Login succeeded, but the session could not be created. Please try again."
                    }
                );

            }


            console.log(
                "Session saved successfully"
            );


            console.log(
                `User logged in successfully: ${user.username} (${user.email})`
            );


            console.log(
                "Redirecting to /dashboard"
            );


            console.log(
                "=========================================="
            );

            console.log("");


            return res.redirect("/dashboard");

        });


    } catch (error) {

        console.error("");
        console.error("==========================================");
        console.error("LOGIN ERROR");
        console.error("==========================================");
        console.error(error);
        console.error("==========================================");
        console.error("");


        return res.status(500).render(
            "login",
            {
                title: "Login",
                error:
                    "An error occurred while signing in. Please check the server console."
            }
        );

    }

});


// =====================================================
// LOGOUT
// PUBLIC ROUTE
// =====================================================

// GET /logout
app.get("/logout", (req, res) => {

    req.session.destroy((err) => {

        if (err) {

            console.error(
                "LOGOUT ERROR:",
                err
            );

            return res.status(500).send(
                "An error occurred while logging out."
            );

        }


        return res.redirect("/login");

    });

});


// =====================================================
// APPLICATION ROUTES
// AUTHENTICATION REQUIRED
// =====================================================

// Home / main application
app.use(
    "/",
    requireLogin,
    indexRoutes
);


// Audits
app.use(
    "/audits",
    requireLogin,
    guard("audits"),
    auditsRoutes
);


// Training Gap Analysis
app.use(
    "/training/gap-analysis",
    requireLogin,
    guard("requirements"),
    trainingGapRoutes
);


// Dashboard
app.use(
    "/dashboard",
    requireLogin,
    dashboardRoutes
);


// Departments
app.use(
    "/departments",
    requireLogin,
    guard("departments"),
    departmentRoutes
);


// Document Management
app.use(
    "/documents",
    requireLogin,
    documentsRoutes
);


// Employees
app.use(
    "/employees",
    requireLogin,
    guard("employees"),
    employeesRoutes
);


// HSSEQ Data
app.use(
    "/hsseq",
    requireLogin,
    guard("hsseq"),
    hsseqdataRoutes
);


// Incidents
app.use(
    "/incidents",
    requireLogin,
    guard("incidents"),
    incidentsRoutes
);


// Inspections
app.use(
    "/inspections",
    requireLogin,
    guard("inspections"),
    inspectionsRoutes
);


// PPE
app.use(
    "/ppe",
    requireLogin,
    guard("ppe"),
    ppeRoutes
);


// Risk Assessments
app.use(
    "/risk-assessments",
    requireLogin,
    guard("risks"),
    riskRoutes
);


// Permits
app.use(
    "/permits",
    requireLogin,
    guard("permits"),
    permitsRoutes
);


// Training records, annual plan and compliance (the requirements page above stays at /training/gap-analysis)
app.use(
    "/training",
    requireLogin,
    guard("training"),
    trainingRoutes
);


// Management of Change
app.use(
    "/moc",
    requireLogin,
    guard("moc"),
    mocRoutes
);


// Emergency Response Planning (drills)
app.use(
    "/erp",
    requireLogin,
    guard("drills"),
    erpRoutes
);


// Meeting Manager
app.use(
    "/meetings",
    requireLogin,
    guard("meetings"),
    meetingsRoutes
);


// Findings, root causes and actions (every module)
app.use(
    "/findings",
    requireLogin,
    findingsRoutes
);


// Bulk upload, reports and record summaries (every module)
app.use(
    "/tools",
    requireLogin,
    toolsRoutes
);


// Audit / inspection checklists (Admin only)
app.use(
    "/checklists",
    requireLogin,
    requireAdmin,
    checklistRoutes
);


// User accounts (Admin only)
app.use(
    "/users",
    requireLogin,
    requireAdmin,
    usersRoutes
);


// =====================================================
// TEST TRAINING ROUTE
// AUTHENTICATION REQUIRED
// =====================================================

app.get(
    "/test-training",
    requireLogin,
    (req, res) => {

        res.send(
            "Training route is working"
        );

    }
);


// =====================================================
// 404 HANDLER
// =====================================================

app.use((req, res) => {

    res.status(404).send(`
        <h1>404 - Page Not Found</h1>
        <p>Cannot ${req.method} ${req.originalUrl}</p>
    `);

});


// =====================================================
// SERVER ERROR HANDLER
// =====================================================

app.use(
    (err, req, res, next) => {

        console.error(
            "SERVER ERROR:",
            err
        );

        res.status(500).send(`
            <h1>500 - Server Error</h1>
            <pre>${err.message}</pre>
        `);

    }
);


// =====================================================
// START SERVER
// =====================================================

const PORT = 3000;

app.listen(
    PORT,
    () => {

        console.log("");

        console.log(
            "=========================================="
        );

        console.log(
            "SafetyPro server running"
        );

        console.log(
            "=========================================="
        );

        console.log(
            `Main URL: http://localhost:${PORT}`
        );

        console.log(
            `Login: http://localhost:${PORT}/login`
        );

        console.log(
            `Training: http://localhost:${PORT}/training/gap-analysis`
        );

        console.log(
            `Dashboard: http://localhost:${PORT}/dashboard`
        );

        console.log(
            `Test: http://localhost:${PORT}/test-training`
        );

        console.log(
            "=========================================="
        );

        console.log("");

    }
);