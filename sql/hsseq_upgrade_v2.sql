-- =====================================================
-- SAFETYPRO UPGRADE v2
--   * Unified Findings -> Root causes -> Actions engine (all modules)
--   * Role-tied action owners (automatic reassignment) + line-manager approval
--   * Checklists for audits / inspections
--   * Management of Change, Emergency Response drills, Meetings
--   * Training endorsement (line manager + evidence)
--   * Location columns and a unified record view for the dashboard
--
-- Run against hsseq_db (MySQL 8):
--     mysql -u root -p hsseq_db < sql/hsseq_upgrade_v2.sql
--
-- Safe to re-run. Existing data is never deleted; existing tables are only
-- extended with new nullable columns.
-- =====================================================

USE hsseq_db;


-- =====================================================
-- 1. EXTEND EXISTING TABLES (each column added only if missing)
-- =====================================================

-- 1a. Employees: line manager (approves actions and trainings)
SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE employees ADD COLUMN line_manager_id INT NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'line_manager_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 1b. Risk assessments: location
SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE risk_assessments ADD COLUMN location VARCHAR(100) NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'risk_assessments' AND COLUMN_NAME = 'location');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 1c. HSSEQ data: location
SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE hsseq_data ADD COLUMN location VARCHAR(100) NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hsseq_data' AND COLUMN_NAME = 'location');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 1d. Training: endorsement by line manager, with evidence.
--     @fresh_training = 1 only the first time this script runs.
SET @fresh_training = (SELECT IF(COUNT(*) = 0, 1, 0)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'training' AND COLUMN_NAME = 'endorsed_at');

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE training ADD COLUMN endorsed_by INT NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'training' AND COLUMN_NAME = 'endorsed_by');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE training ADD COLUMN endorsed_at DATETIME NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'training' AND COLUMN_NAME = 'endorsed_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE training ADD COLUMN endorsement_comments TEXT NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'training' AND COLUMN_NAME = 'endorsement_comments');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE training ADD COLUMN evidence_path VARCHAR(255) NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'training' AND COLUMN_NAME = 'evidence_path');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Trainings that existed before the endorsement workflow are treated as endorsed
-- (so existing compliance results do not change). Runs once only.
UPDATE training
SET endorsed_at = NOW(),
    endorsement_comments = 'Legacy record (before endorsement workflow)'
WHERE @fresh_training = 1 AND endorsed_at IS NULL;

-- 1e. Annual training plans should point at `roles` (the table employees use),
--     not the empty `job_roles` table.
SET @fk = (SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'annual_training_plans'
      AND COLUMN_NAME = 'role_id' AND REFERENCED_TABLE_NAME = 'job_roles' LIMIT 1);
SET @s = IF(@fk IS NULL, 'SELECT 1',
    CONCAT('ALTER TABLE annual_training_plans DROP FOREIGN KEY ', @fk));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE annual_training_plans ADD CONSTRAINT fk_plans_role FOREIGN KEY (role_id) REFERENCES roles (role_id)',
    'SELECT 1')
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'annual_training_plans'
      AND COLUMN_NAME = 'role_id' AND REFERENCED_TABLE_NAME = 'roles');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- =====================================================
-- 2. FINDINGS -> ROOT CAUSES -> ACTIONS (used by every module)
--    module = module key (incidents, audits, inspections, permits, risks,
--    ppe, hsseq, training, moc, drills, meetings) ; record_id = its primary key
-- =====================================================

CREATE TABLE IF NOT EXISTS record_findings (
    finding_id     INT          NOT NULL AUTO_INCREMENT,
    module         VARCHAR(30)  NOT NULL,
    record_id      INT          NOT NULL,
    description    TEXT         NOT NULL,
    severity       VARCHAR(20)  NOT NULL DEFAULT 'Minor',      -- Observation / Minor / Major / Critical
    status         VARCHAR(20)  NOT NULL DEFAULT 'Open',       -- Open / Closed (closes when all its actions close)
    raised_by      INT          NULL,                          -- users.user_id
    raised_at      TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at      DATETIME     NULL,
    legacy_source  VARCHAR(40)  NULL,
    PRIMARY KEY (finding_id),
    UNIQUE KEY uq_findings_legacy (legacy_source),
    KEY idx_findings_record (module, record_id),
    KEY idx_findings_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS record_root_causes (
    root_cause_id  INT          NOT NULL AUTO_INCREMENT,
    finding_id     INT          NOT NULL,
    category       VARCHAR(50)  NOT NULL DEFAULT 'Other',
    description    TEXT         NOT NULL,
    raised_by      INT          NULL,
    raised_at      TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (root_cause_id),
    KEY idx_rc_finding (finding_id),
    CONSTRAINT fk_rc_finding FOREIGN KEY (finding_id)
        REFERENCES record_findings (finding_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- An action is tied to a ROLE (responsible_role_id). Whoever currently holds that
-- role is responsible (see v_action_owners), so a new starter inherits the action
-- automatically. assigned_employee_id is an optional named owner; if that person
-- leaves (status <> 'Active') the action falls back to the role holders.
-- finding_id may be NULL for general actions (e.g. actions arising from meeting minutes).
CREATE TABLE IF NOT EXISTS record_actions (
    action_id             INT          NOT NULL AUTO_INCREMENT,
    finding_id            INT          NULL,
    module                VARCHAR(30)  NOT NULL,
    record_id             INT          NOT NULL,
    root_cause_id         INT          NULL,
    description           TEXT         NOT NULL,
    due_date              DATE         NULL,
    priority              VARCHAR(30)  NOT NULL DEFAULT 'Medium',
    action_party          VARCHAR(150) NULL,                   -- free-text party (e.g. contractor)
    responsible_role_id   INT          NULL,
    assigned_employee_id  INT          NULL,
    status                VARCHAR(30)  NOT NULL DEFAULT 'Open', -- Open / In Progress / Pending Approval / Closed
    completion_notes      TEXT         NULL,
    evidence_path         VARCHAR(255) NULL,
    completed_by          INT          NULL,                   -- users.user_id
    completed_at          DATETIME     NULL,
    approved_by           INT          NULL,                   -- users.user_id (line manager)
    approved_at           DATETIME     NULL,
    approval_comments     TEXT         NULL,
    raised_by             INT          NULL,
    raised_at             TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    legacy_source         VARCHAR(40)  NULL,
    PRIMARY KEY (action_id),
    UNIQUE KEY uq_actions_legacy (legacy_source),
    KEY idx_actions_record (module, record_id),
    KEY idx_actions_finding (finding_id),
    KEY idx_actions_status (status),
    KEY idx_actions_due (due_date),
    CONSTRAINT fk_actions_finding FOREIGN KEY (finding_id)
        REFERENCES record_findings (finding_id) ON DELETE CASCADE,
    CONSTRAINT fk_actions_root_cause FOREIGN KEY (root_cause_id)
        REFERENCES record_root_causes (root_cause_id) ON DELETE SET NULL,
    CONSTRAINT fk_actions_role FOREIGN KEY (responsible_role_id)
        REFERENCES roles (role_id) ON DELETE SET NULL,
    CONSTRAINT fk_actions_employee FOREIGN KEY (assigned_employee_id)
        REFERENCES employees (employee_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Who is responsible for each action RIGHT NOW (recalculated on every query,
-- so staff changes reassign actions automatically).
CREATE OR REPLACE VIEW v_action_owners AS
SELECT a.action_id, e.employee_id
FROM record_actions a
JOIN employees e
  ON e.status = 'Active'
 AND (
        e.employee_id = a.assigned_employee_id
     OR (
            a.responsible_role_id IS NOT NULL
        AND e.role_id = a.responsible_role_id
        AND NOT EXISTS (
                SELECT 1 FROM employees n
                WHERE n.employee_id = a.assigned_employee_id
                  AND n.status = 'Active'
            )
        )
     );


-- =====================================================
-- 3. MIGRATE LEGACY corrective_actions INTO THE NEW ENGINE (once per row)
-- =====================================================

INSERT IGNORE INTO record_findings
    (module, record_id, description, severity, status, closed_at, legacy_source)
SELECT
    CASE ca.source_type WHEN 'Inspection' THEN 'inspections' WHEN 'Audit' THEN 'audits'
                        ELSE LOWER(ca.source_type) END,
    ca.source_id,
    COALESCE(NULLIF(TRIM(ca.related_finding), ''), LEFT(ca.action_description, 250)),
    'Minor',
    IF(ca.status IN ('Completed', 'Closed'), 'Closed', 'Open'),
    IF(ca.status IN ('Completed', 'Closed'), ca.completion_date, NULL),
    CONCAT('corrective_actions:', ca.action_id)
FROM corrective_actions ca
WHERE ca.source_id IS NOT NULL AND ca.source_type IS NOT NULL;

INSERT IGNORE INTO record_actions
    (finding_id, module, record_id, description, due_date, priority,
     responsible_role_id, assigned_employee_id, status, completed_at,
     approval_comments, legacy_source)
SELECT
    f.finding_id, f.module, f.record_id,
    ca.action_description, ca.due_date, COALESCE(ca.priority, 'Medium'),
    emp.role_id, ca.responsible_person,
    CASE WHEN ca.status IN ('Completed', 'Closed') THEN 'Closed'
         WHEN ca.status = 'In Progress' THEN 'In Progress'
         ELSE 'Open' END,
    ca.completion_date,
    IF(ca.status IN ('Completed', 'Closed'), 'Migrated (closed before the approval workflow existed)', NULL),
    CONCAT('corrective_actions:', ca.action_id)
FROM corrective_actions ca
JOIN record_findings f ON f.legacy_source = CONCAT('corrective_actions:', ca.action_id)
LEFT JOIN employees emp ON emp.employee_id = ca.responsible_person;


-- =====================================================
-- 4. CHECKLISTS (audits and inspections)
-- =====================================================

CREATE TABLE IF NOT EXISTS checklist_templates (
    template_id  INT          NOT NULL AUTO_INCREMENT,
    module       VARCHAR(30)  NOT NULL,                 -- audits / inspections
    name         VARCHAR(150) NOT NULL,
    description  VARCHAR(500) NULL,
    active       TINYINT(1)   NOT NULL DEFAULT 1,
    created_by   INT          NULL,
    created_at   TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (template_id),
    UNIQUE KEY uq_checklist_name (module, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS checklist_items (
    item_id      INT          NOT NULL AUTO_INCREMENT,
    template_id  INT          NOT NULL,
    sort_order   INT          NOT NULL DEFAULT 0,
    question     TEXT         NOT NULL,
    PRIMARY KEY (item_id),
    KEY idx_items_template (template_id, sort_order),
    CONSTRAINT fk_items_template FOREIGN KEY (template_id)
        REFERENCES checklist_templates (template_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS checklist_responses (
    response_id  INT          NOT NULL AUTO_INCREMENT,
    module       VARCHAR(30)  NOT NULL,
    record_id    INT          NOT NULL,
    item_id      INT          NOT NULL,
    result       VARCHAR(20)  NOT NULL,                 -- Compliant / Non-compliant / N/A
    comment      VARCHAR(500) NULL,
    finding_id   INT          NULL,                     -- finding raised for a non-compliance
    answered_by  INT          NULL,
    answered_at  TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (response_id),
    UNIQUE KEY uq_response (module, record_id, item_id),
    CONSTRAINT fk_resp_item FOREIGN KEY (item_id)
        REFERENCES checklist_items (item_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- =====================================================
-- 5. MANAGEMENT OF CHANGE
-- =====================================================

CREATE TABLE IF NOT EXISTS moc_records (
    moc_id                INT          NOT NULL AUTO_INCREMENT,
    moc_number            VARCHAR(40)  NOT NULL,                  -- MOC-2026-001
    title                 VARCHAR(200) NOT NULL,
    change_type           VARCHAR(50)  NOT NULL,                  -- Process, Equipment, Procedure, Organisational ...
    duration_type         VARCHAR(20)  NOT NULL DEFAULT 'Permanent', -- Permanent / Temporary / Emergency
    location              VARCHAR(100) NULL,
    description           TEXT         NULL,
    reason                TEXT         NULL,
    risk_level            VARCHAR(20)  NULL,
    proposed_by           INT          NULL,                      -- employees
    approver_id           INT          NULL,                      -- employees (designated approver)
    request_date          DATE         NULL,
    planned_date          DATE         NULL,
    expiry_date           DATE         NULL,                      -- for temporary changes
    status                VARCHAR(30)  NOT NULL DEFAULT 'Submitted', -- Submitted / Approved / Rejected / Implemented / Closed
    decided_by            INT          NULL,                      -- users.user_id
    decided_at            DATETIME     NULL,
    decision_comments     TEXT         NULL,
    created_by            INT          NULL,
    created_at            TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (moc_id),
    UNIQUE KEY uq_moc_number (moc_number),
    KEY idx_moc_location (location),
    KEY idx_moc_status (status),
    CONSTRAINT fk_moc_proposed FOREIGN KEY (proposed_by) REFERENCES employees (employee_id) ON DELETE SET NULL,
    CONSTRAINT fk_moc_approver FOREIGN KEY (approver_id) REFERENCES employees (employee_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- =====================================================
-- 6. EMERGENCY RESPONSE DRILLS (annual plan)
-- =====================================================

CREATE TABLE IF NOT EXISTS erp_drills (
    drill_id          INT          NOT NULL AUTO_INCREMENT,
    plan_year         INT          NOT NULL,
    drill_type        VARCHAR(60)  NOT NULL,          -- Fire, Evacuation, Spill, First aid ...
    title             VARCHAR(200) NOT NULL,
    scenario          TEXT         NULL,
    location          VARCHAR(100) NULL,
    planned_date      DATE         NOT NULL,
    actual_date       DATE         NULL,
    coordinator_id    INT          NULL,              -- employees
    participants      INT          NULL,
    duration_minutes  INT          NULL,
    status            VARCHAR(30)  NOT NULL DEFAULT 'Planned',  -- Planned / Completed / Postponed / Cancelled
    objectives        TEXT         NULL,
    outcome_summary   TEXT         NULL,
    created_by        INT          NULL,
    created_at        TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (drill_id),
    KEY idx_drills_year (plan_year, planned_date),
    KEY idx_drills_location (location),
    CONSTRAINT fk_drills_coordinator FOREIGN KEY (coordinator_id)
        REFERENCES employees (employee_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- =====================================================
-- 7. MEETINGS (record, attendance, minutes; actions use record_actions)
-- =====================================================

CREATE TABLE IF NOT EXISTS meetings (
    meeting_id        INT          NOT NULL AUTO_INCREMENT,
    title             VARCHAR(200) NOT NULL,
    meeting_type      VARCHAR(60)  NOT NULL,          -- Toolbox talk, HSSEQ committee, Management review ...
    meeting_date      DATE         NOT NULL,
    start_time        TIME         NULL,
    location          VARCHAR(100) NULL,
    chairperson_id    INT          NULL,              -- employees
    agenda            TEXT         NULL,
    status            VARCHAR(30)  NOT NULL DEFAULT 'Scheduled',  -- Scheduled / Held / Cancelled
    created_by        INT          NULL,
    created_at        TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (meeting_id),
    KEY idx_meetings_date (meeting_date),
    KEY idx_meetings_location (location),
    CONSTRAINT fk_meetings_chair FOREIGN KEY (chairperson_id)
        REFERENCES employees (employee_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS meeting_attendees (
    attendee_id    INT          NOT NULL AUTO_INCREMENT,
    meeting_id     INT          NOT NULL,
    employee_id    INT          NULL,                 -- NULL for external attendees
    attendee_name  VARCHAR(120) NOT NULL,
    attendance     VARCHAR(20)  NOT NULL DEFAULT 'Present',   -- Present / Absent / Apologies
    PRIMARY KEY (attendee_id),
    UNIQUE KEY uq_attendee (meeting_id, employee_id),
    CONSTRAINT fk_att_meeting FOREIGN KEY (meeting_id)
        REFERENCES meetings (meeting_id) ON DELETE CASCADE,
    CONSTRAINT fk_att_employee FOREIGN KEY (employee_id)
        REFERENCES employees (employee_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS meeting_minutes (
    minute_id   INT          NOT NULL AUTO_INCREMENT,
    meeting_id  INT          NOT NULL,
    item_no     INT          NOT NULL DEFAULT 1,
    topic       VARCHAR(200) NOT NULL,
    discussion  TEXT         NULL,
    decision    TEXT         NULL,
    created_by  INT          NULL,
    PRIMARY KEY (minute_id),
    KEY idx_minutes_meeting (meeting_id, item_no),
    CONSTRAINT fk_min_meeting FOREIGN KEY (meeting_id)
        REFERENCES meetings (meeting_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- =====================================================
-- 8. UNIFIED RECORD VIEW
-- One row per record of every module with the same attributes (date, location,
-- department, owner, activity, status). The dashboard and the findings/actions
-- pages use it so filters work the same way everywhere.
-- =====================================================

CREATE OR REPLACE VIEW v_records AS
SELECT 'incidents' AS module, i.incident_id AS record_id,
       CONCAT('Incident #', i.incident_id, ' - ', COALESCE(i.incident_type, '')) AS title,
       DATE(i.incident_date) AS record_date, i.location AS location,
       e.department_id AS department_id, i.reported_by AS employee_id,
       i.incident_type AS activity, i.status AS status
FROM incidents i LEFT JOIN employees e ON e.employee_id = i.reported_by

UNION ALL
SELECT 'audits', a.audit_id,
       CONCAT('Audit #', a.audit_id, ' - ', COALESCE(a.audit_type, '')),
       a.audit_date,
       (SELECT d.location FROM departments d WHERE d.department_id = a.department_id LIMIT 1),
       a.department_id,
       (SELECT MIN(x.employee_id) FROM employees x WHERE x.employee_name = a.auditor),
       a.audit_type, a.status
FROM audits a

UNION ALL
SELECT 'inspections', n.inspection_id,
       CONCAT('Inspection #', n.inspection_id, ' - ', COALESCE(n.inspection_type, '')),
       n.inspection_date, n.location, e.department_id, n.inspector_id,
       n.inspection_type, n.status
FROM inspections n LEFT JOIN employees e ON e.employee_id = n.inspector_id

UNION ALL
SELECT 'permits', p.permit_id,
       CONCAT('Permit ', p.permit_number, ' - ', COALESCE(p.permit_type, '')),
       DATE(p.issue_date), p.location, e.department_id, p.requested_by,
       p.permit_type, p.status
FROM permits p LEFT JOIN employees e ON e.employee_id = p.requested_by

UNION ALL
SELECT 'risks', r.risk_id,
       CONCAT('Risk #', r.risk_id, ' - ', COALESCE(r.activity, '')),
       r.assessment_date,
       COALESCE(r.location, (SELECT d.location FROM departments d WHERE d.department_id = e.department_id LIMIT 1)),
       e.department_id, r.responsible_person, r.activity, r.risk_level
FROM risk_assessments r LEFT JOIN employees e ON e.employee_id = r.responsible_person

UNION ALL
SELECT 'ppe', p.id,
       CONCAT('PPE - ', COALESCE(p.item_name, '')),
       DATE(p.created_at),
       (SELECT d.location FROM departments d WHERE d.department_name = p.department LIMIT 1),
       (SELECT MIN(d.department_id) FROM departments d WHERE d.department_name = p.department),
       NULL, p.category, p.status
FROM ppe_inventory p

UNION ALL
SELECT 'hsseq', h.hsseq_id,
       CONCAT('HSSEQ data ', h.record_year, '-', LPAD(h.record_month, 2, '0')),
       STR_TO_DATE(CONCAT(h.record_year, '-', h.record_month, '-01'), '%Y-%m-%d'),
       h.location, NULL, NULL, 'Monthly data', 'Recorded'
FROM hsseq_data h

UNION ALL
SELECT 'training', t.training_id,
       CONCAT('Training - ', COALESCE(e.employee_name, ''), ' - ', COALESCE(t.training_name, '')),
       t.training_date,
       (SELECT d.location FROM departments d WHERE d.department_id = e.department_id LIMIT 1),
       e.department_id, t.employee_id, t.training_name, t.status
FROM training t LEFT JOIN employees e ON e.employee_id = t.employee_id

UNION ALL
SELECT 'moc', m.moc_id,
       CONCAT(m.moc_number, ' - ', m.title),
       m.request_date, m.location, e.department_id, m.proposed_by,
       m.change_type, m.status
FROM moc_records m LEFT JOIN employees e ON e.employee_id = m.proposed_by

UNION ALL
SELECT 'drills', d.drill_id,
       CONCAT(d.plan_year, ' - ', d.title),
       COALESCE(d.actual_date, d.planned_date), d.location, e.department_id, d.coordinator_id,
       d.drill_type, d.status
FROM erp_drills d LEFT JOIN employees e ON e.employee_id = d.coordinator_id

UNION ALL
SELECT 'meetings', mt.meeting_id,
       CONCAT(mt.title, ' (', mt.meeting_date, ')'),
       mt.meeting_date, mt.location, e.department_id, mt.chairperson_id,
       mt.meeting_type, mt.status
FROM meetings mt LEFT JOIN employees e ON e.employee_id = mt.chairperson_id;


-- =====================================================
-- 9. ASSIGN ROLES (edit the usernames, then uncomment)
--   Admin       : everything, and the only role that can delete
--   User        : view + add records (not edit / delete)
--   Permit issuer / Risk assessor : may add + edit permits / risk assessments,
--                 but only while their PTW / Risk Assessment training is < 2 years old
--   Line Manager: approves actions/trainings when the owner has no line manager set
--   (Author / Reviewer / Publisher are used by Document Management)
-- =====================================================

-- UPDATE users SET role = 'Line Manager' WHERE username = 'wangai';
-- SELECT user_id, username, employee_id, role FROM users ORDER BY role, username;

-- Set each employee's line manager (used to approve their actions and trainings):
-- UPDATE employees SET line_manager_id = 21 WHERE employee_id IN (11, 15);
