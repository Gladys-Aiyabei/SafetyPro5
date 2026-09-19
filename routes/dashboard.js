```javascript
const express = require("express");
const router = express.Router();
const db = require("../db");


// =====================================================
// DASHBOARD ROUTE
// GET /dashboard
// =====================================================

router.get("/", async (req, res) => {

    try {

        // -------------------------------------------------
        // 1. Get filters from URL
        // -------------------------------------------------

        const {
            department,
            location,
            year,
            month,
            status
        } = req.query;


        // -------------------------------------------------
        // 2. Years
        // -------------------------------------------------

        const currentYear = year || new Date().getFullYear();

        const currentCalendarYear = new Date().getFullYear();

        const years = [];

        for (
            let y = currentCalendarYear;
            y >= currentCalendarYear - 5;
            y--
        ) {
            years.push(y);
        }


        // -------------------------------------------------
        // 3. Months
        // -------------------------------------------------

        const months = [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December"
        ];


        // -------------------------------------------------
        // 4. Get departments
        // -------------------------------------------------

        const [departments] = await db.query(`
            SELECT
                department_id AS id,
                department_name AS name,
                location
            FROM departments
            ORDER BY department_name
        `);


        // -------------------------------------------------
        // 5. Get unique locations
        // -------------------------------------------------

        const [locationRows] = await db.query(`
            SELECT DISTINCT
                location
            FROM departments
            WHERE location IS NOT NULL
              AND TRIM(location) <> ''
            ORDER BY location
        `);


        const locations = locationRows.map(row => ({
            id: row.location,
            name: row.location
        }));


        // -------------------------------------------------
        // 6. Active filter labels
        // -------------------------------------------------

        let activeDepartmentLabel = "All";
        let activeLocationLabel = "All";
        let activePeriodLabel = "Full Year";
        let activeStatusLabel = "All";


        if (department) {

            const selectedDepartment = departments.find(
                dept => String(dept.id) === String(department)
            );

            if (selectedDepartment) {
                activeDepartmentLabel = selectedDepartment.name;
            }
        }


        if (location) {

            const selectedLocation = locations.find(
                loc => String(loc.id) === String(location)
            );

            if (selectedLocation) {
                activeLocationLabel = selectedLocation.name;
            }
        }


        if (month && month !== "all") {

            const monthNumber = Number(month);

            if (monthNumber >= 1 && monthNumber <= 12) {
                activePeriodLabel = months[monthNumber - 1];
            }
        }


        if (status === "open") {
            activeStatusLabel = "Open / Action Needed";
        }

        if (status === "closed") {
            activeStatusLabel = "Closed / Compliant";
        }


        const activeFilterLabels = {
            department: activeDepartmentLabel,
            location: activeLocationLabel,
            period: activePeriodLabel,
            status: activeStatusLabel
        };


        // -------------------------------------------------
        // 7. Dashboard KPIs
        // -------------------------------------------------

        const kpis = {

            activeIncidents: {
                open: 4,
                resolved: 12
            },

            auditComplianceRate: 92,

            pendingCAPA: {
                high: 2,
                medium: 5,
                low: 3
            },

            ppeComplianceRate: 98

        };


        // -------------------------------------------------
        // 8. Safety ratios
        // -------------------------------------------------

        const ratios = {

            ltif: "0.85",

            trcf: "1.20",

            smvir: "0.00",

            rollover: "0"

        };


        // -------------------------------------------------
        // 9. Risk matrix data
        // -------------------------------------------------

        const riskMatrixData = {

            "5-1": 0,
            "5-2": 1,
            "5-3": 0,
            "5-4": 2,
            "5-5": 0,

            "4-1": 1,
            "4-2": 4,
            "4-3": 1,
            "4-4": 0,
            "4-5": 0,

            "3-1": 0,
            "3-2": 2,
            "3-3": 8,
            "3-4": 1,
            "3-5": 0,

            "2-1": 3,
            "2-2": 5,
            "2-3": 2,
            "2-4": 0,
            "2-5": 0,

            "1-1": 12,
            "1-2": 4,
            "1-3": 1,
            "1-4": 0,
            "1-5": 0

        };


        // -------------------------------------------------
        // 10. Risk summary
        // -------------------------------------------------

        const riskSummary = {

            total: Object.values(riskMatrixData).reduce(
                (total, count) => total + Number(count || 0),
                0
            )

        };


        // -------------------------------------------------
        // 11. Risk labels
        // -------------------------------------------------

        const riskLabels = {

            likelihood: {
                1: "Rare",
                2: "Unlikely",
                3: "Possible",
                4: "Likely",
                5: "Almost Certain"
            },

            severity: {
                1: "Insignificant",
                2: "Minor",
                3: "Moderate",
                4: "Major",
                5: "Severe"
            }

        };


        // -------------------------------------------------
        // 12. Training data
        // -------------------------------------------------

        const trainingData = [

            {
                employeeGroup: "Logistics",
                module: "Defensive Driving",
                percentage: 88
            },

            {
                employeeGroup: "Operations",
                module: "Lockout-Tagout",
                percentage: 95
            },

            {
                employeeGroup: "All Personnel",
                module: "Fire Safety & Evacuation",
                percentage: 74
            }

        ];


        // -------------------------------------------------
        // 13. Chart data
        // -------------------------------------------------

        const chartData = {

            incidentsTrend: {

                labels: [
                    "Jan",
                    "Feb",
                    "Mar",
                    "Apr",
                    "May",
                    "Jun",
                    "Jul",
                    "Aug",
                    "Sep",
                    "Oct",
                    "Nov",
                    "Dec"
                ],

                values: [
                    2,
                    3,
                    1,
                    4,
                    2,
                    3,
                    1,
                    5,
                    2,
                    3,
                    1,
                    2
                ]

            },


            inspectionsStatus: {

                labels: [
                    "Compliant",
                    "Non-Compliant",
                    "Pending"
                ],

                values: [
                    70,
                    15,
                    15
                ]

            },


            auditPerformance: {

                labels: [
                    "Health & Safety",
                    "Engineering",
                    "Operations",
                    "Quality Assurance",
                    "Environment",
                    "Maintenance"
                ],

                values: [
                    92,
                    88,
                    95,
                    90,
                    86,
                    91
                ]

            },


            capaResolution: {

                labels: [
                    "Open",
                    "In Progress",
                    "Closed"
                ],

                values: [
                    10,
                    7,
                    25
                ]

            },


            impactMetrics: {

                labels: [
                    "Waste",
                    "Emissions",
                    "Water",
                    "Energy"
                ],

                values: [
                    85,
                    78,
                    90,
                    82
                ]

            }

        };


        // -------------------------------------------------
        // 14. Export data
        // -------------------------------------------------

        const exportRows = [];


        // -------------------------------------------------
        // 15. Last updated
        // -------------------------------------------------

        const lastUpdated = new Date().toLocaleString();


        // -------------------------------------------------
        // 16. Render dashboard
        // -------------------------------------------------

        res.render("dashboard", {

            title: "HSSEQ Executive Dashboard",

            departments,

            locations,

            years,

            months,

            filters: {

                department: department || "",

                location: location || "",

                year: currentYear,

                month: month || "all",

                status: status || ""

            },

            activeFilterLabels,

            lastUpdated,

            kpis,

            ratios,

            riskMatrixData,

            riskSummary,

            riskLabels,

            trainingData,

            chartData,

            exportRows

        });


    } catch (error) {

        console.error(
            "Dashboard routing error:",
            error
        );

        res.status(500).send(
            "Error compiling dashboard datasets."
        );

    }

});


// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;
```

**Save it exactly here:**

```text
C:\Users\ADMIN\Downloads\SafetyPro5\routes\dashboard.js
```

Then restart your server:

```bash
Ctrl + C
node app.js
```

And open:

```text
http://localhost:3000/dashboard
```

The important fix is this query:

```javascript
SELECT
    department_id AS id,
    department_name AS name,
    location
FROM departments
```

It matches your actual database columns and eliminates the `Unknown column 'id'` error.
