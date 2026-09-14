// ==========================================
// EXPRESS SERVER
// ==========================================

const express = require("express");
const app = express();

const session = require("express-session");
const path = require("path");

// Database
const db = require("./db");

// ==========================================
// IMPORT ROUTES
// ==========================================

const indexRoutes = require("./routes/index");
const trainingGapRoutes = require("./routes/training_gap_analysis");
const auditsRoutes = require("./routes/audits");
const dashboardRoutes = require("./routes/dashboard");
const departmentRoutes = require("./routes/department");
const employeesRoutes = require("./routes/employees");
const hsseqdataRoutes = require("./routes/hsseqdata");
const incidentsRoutes = require("./routes/incidents");
const inspectionsRoutes = require("./routes/inspections");
const loginRoutes = require("./routes/login");
const logoutRoutes = require("./routes/logout");
const ppeRoutes = require("./routes/ppe");
const riskRoutes = require("./routes/risk_assesments");
const permitsRoutes = require("./routes/permits");

// ==========================================
// VIEW ENGINE
// ==========================================

app.set("view engine", "ejs");

app.set(
    "views",
    path.join(__dirname, "views")
);

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

app.use(
    express.urlencoded({
        extended: true
    })
);

app.use(express.json());

app.use(
    session({
        secret: "safetypro5-secret",
        resave: false,
        saveUninitialized: false
    })
);

// ==========================================
// CHECK ROUTES
// ==========================================

console.log("indexRoutes:", typeof indexRoutes);
console.log("trainingGapRoutes:", typeof trainingGapRoutes);
console.log("auditsRoutes:", typeof auditsRoutes);
console.log("dashboardRoutes:", typeof dashboardRoutes);
console.log("departmentRoutes:", typeof departmentRoutes);
console.log("employeesRoutes:", typeof employeesRoutes);
console.log("hsseqdataRoutes:", typeof hsseqdataRoutes);
console.log("incidentsRoutes:", typeof incidentsRoutes);
console.log("inspectionsRoutes:", typeof inspectionsRoutes);
console.log("loginRoutes:", typeof loginRoutes);
console.log("logoutRoutes:", typeof logoutRoutes);
console.log("ppeRoutes:", typeof ppeRoutes);
console.log("riskRoutes:", typeof riskRoutes);
console.log("permitsRoutes:", typeof permitsRoutes);

// ==========================================
// ROUTES
// ==========================================

app.use("/", indexRoutes);

app.use("/audits", auditsRoutes);

app.use(
    "/training_gap_analysis",
    trainingGapRoutes
);

app.use(
    "/dashboard",
    dashboardRoutes
);

app.use(
    "/departments",
    departmentRoutes
);

app.use(
    "/employees",
    employeesRoutes
);

// ==========================================
// HSSEQ ROUTES
// ==========================================

app.use(
    "/hsseq",
    hsseqdataRoutes
);

app.use(
    "/incidents",
    incidentsRoutes
);

app.use(
    "/inspections",
    inspectionsRoutes
);

app.use(
    "/login",
    loginRoutes
);

app.use(
    "/logout",
    logoutRoutes
);

app.use(
    "/ppe",
    ppeRoutes
);

app.use(
    "/risk-assessments",
    riskRoutes
);

app.use(
    "/permits",
    permitsRoutes
);

// ==========================================
// START SERVER
// ==========================================

app.listen(3000, () => {
    console.log(
        "Server is running on http://localhost:3000"
    );
});