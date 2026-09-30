-- =====================================================
-- DOCUMENT MANAGEMENT MODULE (HSSEQ document control)
-- Run against the hsseq_db database (MySQL 8).
--
--   mysql -u root -p hsseq_db < sql/document_management.sql
--
-- Safe to re-run: tables use IF NOT EXISTS.
-- =====================================================

USE hsseq_db;


-- =====================================================
-- 1. DOCUMENTS
-- One row per controlled document. The content itself
-- lives in document_versions.
-- =====================================================

CREATE TABLE IF NOT EXISTS documents (
    document_id     INT          NOT NULL AUTO_INCREMENT,
    doc_number      VARCHAR(50)  NOT NULL,                    -- e.g. HSE-POL-001
    title           VARCHAR(200) NOT NULL,
    doc_type        VARCHAR(50)  NOT NULL DEFAULT 'Procedure',
    department_id   INT          NULL,
    created_by      INT          NOT NULL,
    created_at      TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (document_id),
    UNIQUE KEY uq_documents_doc_number (doc_number),
    KEY idx_documents_department (department_id),

    CONSTRAINT fk_documents_department
        FOREIGN KEY (department_id) REFERENCES departments (department_id)
        ON DELETE SET NULL,
    CONSTRAINT fk_documents_created_by
        FOREIGN KEY (created_by) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- =====================================================
-- 2. DOCUMENT VERSIONS
-- Every revision of a document. Lifecycle:
--   Draft -> In Review -> Approved -> Published -> Superseded
--   (a reviewer or publisher may send a version back: Returned -> In Review)
-- Only one version per document is 'Published' at a time; it is
-- flipped to 'Superseded' when the next version is published.
-- =====================================================

CREATE TABLE IF NOT EXISTS document_versions (
    version_id       INT          NOT NULL AUTO_INCREMENT,
    document_id      INT          NOT NULL,
    version_no       INT          NOT NULL,                   -- 1, 2, 3 ...
    content          LONGTEXT     NOT NULL,
    change_summary   VARCHAR(500) NULL,
    status           ENUM('Draft','In Review','Returned','Approved','Published','Superseded')
                                  NOT NULL DEFAULT 'Draft',

    author_id        INT          NOT NULL,
    reviewer_id      INT          NULL,
    reviewed_at      DATETIME     NULL,
    publisher_id     INT          NULL,
    published_at     DATETIME     NULL,
    effective_date   DATE         NULL,
    review_due_date  DATE         NULL,

    created_at       TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (version_id),
    UNIQUE KEY uq_document_version (document_id, version_no),
    KEY idx_versions_status (status),

    CONSTRAINT fk_versions_document
        FOREIGN KEY (document_id)  REFERENCES documents (document_id) ON DELETE CASCADE,
    CONSTRAINT fk_versions_author
        FOREIGN KEY (author_id)    REFERENCES users (user_id),
    CONSTRAINT fk_versions_reviewer
        FOREIGN KEY (reviewer_id)  REFERENCES users (user_id),
    CONSTRAINT fk_versions_publisher
        FOREIGN KEY (publisher_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- =====================================================
-- 3. DOCUMENT HISTORY (audit trail)
-- Append-only log of every workflow step.
-- =====================================================

CREATE TABLE IF NOT EXISTS document_history (
    history_id    BIGINT       NOT NULL AUTO_INCREMENT,
    document_id   INT          NOT NULL,
    version_id    INT          NOT NULL,
    action        VARCHAR(30)  NOT NULL,   -- Created, Edited, New version, Submitted, Approved, Returned, Published, Superseded
    from_status   VARCHAR(20)  NULL,
    to_status     VARCHAR(20)  NULL,
    comments      TEXT         NULL,
    performed_by  INT          NOT NULL,
    performed_at  TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (history_id),
    KEY idx_history_document (document_id, performed_at),
    KEY idx_history_version (version_id),

    CONSTRAINT fk_history_document
        FOREIGN KEY (document_id)  REFERENCES documents (document_id) ON DELETE CASCADE,
    CONSTRAINT fk_history_version
        FOREIGN KEY (version_id)   REFERENCES document_versions (version_id) ON DELETE CASCADE,
    CONSTRAINT fk_history_user
        FOREIGN KEY (performed_by) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- =====================================================
-- 4. ASSIGN WORKFLOW ROLES
-- users.role is a free-text VARCHAR(50), so no schema change is needed:
-- just set the role on the accounts that should author / review / publish.
-- 'Admin' can act in all three roles.
-- Replace the usernames below with real accounts, then run.
-- =====================================================

-- UPDATE users SET role = 'Author'    WHERE username = 'jwangari';
-- UPDATE users SET role = 'Reviewer'  WHERE username = 'jwangai';
-- UPDATE users SET role = 'Publisher' WHERE username = 'wangai';

-- Check the result:
-- SELECT user_id, username, email, role FROM users ORDER BY role, username;
