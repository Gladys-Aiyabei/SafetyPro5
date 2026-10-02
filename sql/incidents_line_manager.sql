-- =====================================================
-- INCIDENTS: LINE MANAGER
-- Run against the hsseq_db database (MySQL 8):
--
--   mysql -u root -p hsseq_db < sql/incidents_line_manager.sql
--
-- Adds incidents.line_manager_id (-> employees.employee_id).
-- Run once; it fails with "Duplicate column name" if already applied.
-- =====================================================

USE hsseq_db;

ALTER TABLE incidents
    ADD COLUMN line_manager_id INT NULL AFTER reported_by,
    ADD KEY line_manager_id (line_manager_id),
    ADD CONSTRAINT incidents_line_manager_fk
        FOREIGN KEY (line_manager_id) REFERENCES employees (employee_id)
        ON DELETE SET NULL;
