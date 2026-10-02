-- =====================================================
-- ACTION DUE NOTICES
-- Run against the hsseq_db database (MySQL 8):
--
--   mysql -u root -p hsseq_db < sql/action_notifications.sql
--
-- Remembers which actions have had their "due" email, one row per action and due date,
-- so each is sent once (and again only if the due date is changed).
-- The app also creates this table by itself on start-up (lib/actionNotify.js).
-- =====================================================

USE hsseq_db;

CREATE TABLE IF NOT EXISTS action_due_notices (
    action_id  INT        NOT NULL,
    due_date   DATE       NOT NULL,
    sent_at    TIMESTAMP  NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (action_id, due_date),
    CONSTRAINT fk_due_notices_action FOREIGN KEY (action_id)
        REFERENCES record_actions (action_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
