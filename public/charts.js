// =====================================================
// Chart helpers (Chart.js 4 must be loaded first)
// Palette: jungle green, blue, yellow, red, then tints.
// =====================================================

(function () {

    var PALETTE = [
        "#29AB87", "#1F5FBF", "#F7B801", "#D62839",
        "#7BCFB5", "#7DA4E0", "#FBD766", "#E88994",
        "#0E4D3A", "#174A96", "#C99400", "#A81E2C"
    ];

    // Status words get their meaning colour, everything else cycles the palette.
    var MEANING = {
        "open": "#D62839", "overdue": "#D62839", "critical": "#D62839", "expired": "#D62839",
        "missing": "#D62839", "rejected": "#D62839", "high": "#E8590C", "non-compliant": "#D62839",
        "in progress": "#F7B801", "pending approval": "#1F5FBF", "pending": "#F7B801",
        "medium": "#F7B801", "approved": "#1F5FBF", "planned": "#1F5FBF", "scheduled": "#1F5FBF",
        "closed": "#29AB87", "completed": "#29AB87", "valid": "#29AB87", "low": "#29AB87",
        "compliant": "#29AB87", "held": "#29AB87", "fully trained": "#29AB87", "active": "#29AB87",
        "on target": "#29AB87", "at risk": "#F7B801", "off target": "#D62839", "no target": "#9AA8A4", "no data": "#C9D2CF"
    };

    function colours(labels) {
        var used = {};
        return labels.map(function (label, i) {
            var m = MEANING[String(label).toLowerCase()];
            return m || PALETTE[i % PALETTE.length];
        });
    }

    // draw("canvasId", { type: "bar"|"line"|"doughnut", labels: [], values: [] , datasets?: [{label, values, color}] })
    window.drawChart = function (id, cfg) {

        var el = document.getElementById(id);
        if (!el || !window.Chart) return;

        var pie = cfg.type === "doughnut" || cfg.type === "pie";

        var datasets;

        if (cfg.datasets) {
            datasets = cfg.datasets.map(function (d, i) {
                var colour = d.color || PALETTE[i % PALETTE.length];
                return {
                    label: d.label,
                    data: d.values,
                    backgroundColor: colour,
                    borderColor: colour,
                    borderWidth: cfg.type === "line" ? 3 : 0,
                    tension: 0.3,
                    fill: false
                };
            });
        } else {
            var cols = pie || cfg.type === "bar" ? colours(cfg.labels) : ["#29AB87"];
            datasets = [{
                label: cfg.label || "Records",
                data: cfg.values,
                backgroundColor: cfg.type === "line" ? "rgba(41,171,135,0.15)" : (cfg.type === "bar" && !cfg.varied ? "#29AB87" : cols),
                borderColor: cfg.type === "line" ? "#29AB87" : "#ffffff",
                borderWidth: cfg.type === "line" ? 3 : (pie ? 2 : 0),
                tension: 0.3,
                fill: cfg.type === "line",
                pointBackgroundColor: "#29AB87"
            }];

            if (cfg.type === "bar" && cfg.varied) datasets[0].backgroundColor = cols;
        }

        new Chart(el, {
            type: cfg.type === "pie" ? "pie" : cfg.type,
            data: { labels: cfg.labels, datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: cfg.horizontal ? "y" : "x",
                plugins: {
                    legend: {
                        display: pie || !!cfg.datasets,
                        position: "bottom"
                    }
                },
                scales: pie ? {} : {
                    y: { beginAtZero: true, ticks: { precision: 0 } },
                    x: { ticks: { maxRotation: 60, minRotation: 0, autoSkip: false } }
                }
            }
        });
    };

})();
