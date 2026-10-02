-- =====================================================
-- FINDINGS & ACTIONS: RESPONSIBLE PERSON + LINE MANAGER
-- Run against the hsseq_db database (MySQL 8):
--
--   mysql -u root -p hsseq_db < sql/findings_responsible.sql
--
-- Every finding and action names a responsible person and a line manager.
-- The action's line manager approves (closes) it.
-- The app also adds these columns by itself on start-up (lib/engine.js ensureSchema).
-- Run once; it fails with "Duplicate column name" if already applied.
-- =====================================================

USE hsseq_db;

ALTER TABLE record_findings
    ADD COLUMN responsible_employee_id INT NULL AFTER severity,
    ADD CONSTRAINT fk_findings_responsible FOREIGN KEY (responsible_employee_id)
        REFERENCES employees (employee_id) ON DELETE SET NULL,
    ADD COLUMN line_manager_id INT NULL AFTER responsible_employee_id,
    ADD CONSTRAINT fk_findings_line_manager FOREIGN KEY (line_manager_id)
        REFERENCES employees (employee_id) ON DELETE SET NULL;

-- assigned_employee_id (already there) is the action's responsible person.
ALTER TABLE record_actions
    ADD COLUMN line_manager_id INT NULL AFTER assigned_employee_id,
    ADD CONSTRAINT fk_actions_line_manager FOREIGN KEY (line_manager_id)
        REFERENCES employees (employee_id) ON DELETE SET NULL;

-- Existing actions: line manager of their named person.
UPDATE record_actions a JOIN employees e ON e.employee_id = a.assigned_employee_id
SET a.line_manager_id = e.line_manager_id
WHERE a.line_manager_id IS NULL;
