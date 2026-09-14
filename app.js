const express = require("express");
const path = require("path");

const app = express();

// ==========================================
// DATABASE
// ==========================================

const db = require("./db");

// ==========================================
// ROUTES
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

// ==========================================
// ROUTES
// ==========================================

app.use("/", indexRoutes);

app.use("/audits", auditsRoutes);

app.use(
    "/training/gap-analysis",
    trainingGapRoutes
);

app.use("/dashboard", dashboardRoutes);

app.use("/departments", departmentRoutes);

app.use("/employees", employeesRoutes);

app.use("/hsseq", hsseqdataRoutes);

app.use("/incidents", incidentsRoutes);

app.use("/inspections", inspectionsRoutes);

app.use("/ppe", ppeRoutes);

app.use("/risk-assessments", riskRoutes);

app.use("/permits", permitsRoutes);

// ==========================================
// TEST ROUTE
// ==========================================

app.get("/test-training", (req, res) => {
    res.send("Training route is working");
});

// ==========================================
// 404
// ==========================================

app.use((req, res) => {
    res.status(404).send(`
        <h1>404 - Page Not Found</h1>
        <p>Cannot ${req.method} ${req.originalUrl}</p>
    `);
});

// ==========================================
// SERVER ERROR
// ==========================================

app.use((err, req, res, next) => {

    console.error("SERVER ERROR:", err);

    res.status(500).send(`
        <h1>500 - Server Error</h1>
        <pre>${err.message}</pre>
    `);
});

// ==========================================
// START SERVER
// ==========================================

const PORT = 3000;

app.listen(PORT, () => {

    console.log("");
    console.log("==========================================");
    console.log("SafetyPro server running");
    console.log("==========================================");
    console.log(
        `Main URL: http://localhost:${PORT}`
    );
    console.log(
        `Training: http://localhost:${PORT}/training/gap-analysis`
    );
    console.log(
        `Test: http://localhost:${PORT}/test-training`
    );
    console.log("==========================================");
    console.log("");

});