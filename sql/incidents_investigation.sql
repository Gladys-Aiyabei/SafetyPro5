-- =====================================================
-- INCIDENTS: INVESTIGATION + HEAD OF SAFETY SIGN-OFF
-- Run against the hsseq_db database (MySQL 8), after incidents_line_manager.sql:
--
--   mysql -u root -p hsseq_db < sql/incidents_investigation.sql
--
-- Run once; the ALTER fails with "Duplicate column name" if already applied.
--
--   incidents            + classification, learnings, rating, sign-off columns
--   incident_findings    (already exists)  findings
--   incident_images      (already exists)  pictures
--   incident_actions     (new)             actions
--   incident_witnesses   (new)             witnesses
--   incident_injuries    (new)             injuries
--   roles                + 'Head of Safety'
-- =====================================================

USE hsseq_db;

-- Classification, learnings, rating + sign-off on the incident itself
-- Rating = likelihood (1-5) x consequence (1-5); score and band are worked out by the app.
ALTER TABLE incidents
    ADD COLUMN classification   VARCHAR(50) NULL AFTER incident_type,
    ADD COLUMN learnings        TEXT        NULL,
    ADD COLUMN likelihood       TINYINT     NULL,
    ADD COLUMN consequence      TINYINT     NULL,
    ADD COLUMN signed_off_by    INT         NULL,
    ADD COLUMN signed_off_at    DATETIME    NULL,
    ADD COLUMN signoff_comments TEXT        NULL,
    ADD KEY signed_off_by (signed_off_by),
    ADD CONSTRAINT incidents_signed_off_fk
        FOREIGN KEY (signed_off_by) REFERENCES employees (employee_id)
        ON DELETE SET NULL;

-- Actions raised by the line manager
CREATE TABLE IF NOT EXISTS incident_actions (
    action_id       INT          NOT NULL AUTO_INCREMENT,
    incident_id     INT          NOT NULL,
    action_text     TEXT         NOT NULL,
    responsible_id  INT          NULL,                    -- employees.employee_id
    due_date        DATE         NULL,
    status          VARCHAR(30)  NOT NULL DEFAULT 'Open', -- Open / In Progress / Completed
    created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (action_id),
    KEY fk_action_incident (incident_id),
    KEY fk_action_responsible (responsible_id),
    CONSTRAINT fk_action_incident FOREIGN KEY (incident_id)
        REFERENCES incidents (incident_id) ON DELETE CASCADE,
    CONSTRAINT fk_action_responsible FOREIGN KEY (responsible_id)
        REFERENCES employees (employee_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Witnesses (free text, so visitors / contractors can be recorded too)
CREATE TABLE IF NOT EXISTS incident_witnesses (
    witness_id    INT           NOT NULL AUTO_INCREMENT,
    incident_id   INT           NOT NULL,
    witness_name  VARCHAR(100)  NOT NULL,
    contact       VARCHAR(100)  NULL,
    statement     TEXT          NULL,
    created_at    DATETIME      DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (witness_id),
    KEY fk_witness_incident (incident_id),
    CONSTRAINT fk_witness_incident FOREIGN KEY (incident_id)
        REFERENCES incidents (incident_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Injuries (one row per injured person)
CREATE TABLE IF NOT EXISTS incident_injuries (
    injury_id       INT           NOT NULL AUTO_INCREMENT,
    incident_id     INT           NOT NULL,
    injured_person  VARCHAR(100)  NOT NULL,
    injury_type     VARCHAR(100)  NULL,                  -- e.g. Cut, Fracture, Burn
    body_part       VARCHAR(100)  NULL,
    treatment       VARCHAR(50)   NULL,                  -- First Aid / Medical Treatment / Lost Time / Fatality
    days_lost       INT           NULL,
    created_at      DATETIME      DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (injury_id),
    KEY fk_injury_incident (incident_id),
    CONSTRAINT fk_injury_incident FOREIGN KEY (incident_id)
        REFERENCES incidents (incident_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Role that signs incidents off. Then set it on the right employee
-- (Employees > Edit > Role), e.g.:
--   UPDATE employees SET role_id = (SELECT role_id FROM roles WHERE role_name = 'Head of Safety')
--   WHERE employee_id = <id>;
INSERT IGNORE INTO roles (role_name, description)
VALUES ('Head of Safety', 'Signs off incident investigations');
