-- =====================================================
-- KPI TARGETS (dashboard sheet "KPI Targets")
-- Run against the hsseq_db database (MySQL 8):
--
--   mysql -u root -p hsseq_db < sql/kpi_targets.sql
--
-- Optional: lib/kpis.js creates the same table on first use.
-- Safe to re-run. Only KPIs an Admin has changed get a row; the rest use the
-- defaults in lib/kpis.js. A row with target NULL means "no target".
-- =====================================================

USE hsseq_db;

CREATE TABLE IF NOT EXISTS kpi_targets (
    kpi_key     VARCHAR(40)   NOT NULL,                 -- key from lib/kpis.js CATALOGUE
    target      DECIMAL(14,2) NULL,                     -- NULL = no target
    margin      DECIMAL(14,2) NOT NULL DEFAULT 0,       -- amber band, in the KPI's own unit
    updated_by  INT           NULL,                     -- users.user_id
    updated_at  TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (kpi_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
