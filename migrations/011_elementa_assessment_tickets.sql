-- ============================================================================
-- Migration: 011_elementa_assessment_tickets.sql
-- Description:
--   1. Creates elementa_assessment_tickets table for 1-hour one-time access codes (QR & alphanumeric).
--   2. Ensures start_date and competitive_enabled columns exist on assessments table.
--   3. Seeds/ensures Pre-Test, Post-Test, and Competitive assessments across all 12 topics.
-- ============================================================================

-- 1. Create elementa_assessment_tickets table
CREATE TABLE IF NOT EXISTS `elementa_assessment_tickets` (
    `ticket_id` INT AUTO_INCREMENT PRIMARY KEY,
    `ticket_code` VARCHAR(32) NOT NULL UNIQUE COMMENT 'Human-readable e.g. ELM-A82F-K91P',
    `qr_token` VARCHAR(64) NOT NULL UNIQUE COMMENT 'Cryptographic token for QR scan',
    `student_id` INT NOT NULL COMMENT 'FK users(user_id)',
    `assessment_id` INT NOT NULL COMMENT 'FK assessments(assessment_id)',
    `topic_id` INT NOT NULL COMMENT 'FK topics(topic_id)',
    `level_number` TINYINT NOT NULL COMMENT 'District level 1-12',
    `play_mode` ENUM('Solo', 'Competitive') DEFAULT 'Solo',
    `player_slot` TINYINT DEFAULT 1 COMMENT '1 for P1, 2 for P2 in Competitive',
    `status` ENUM('Active', 'Consumed', 'Expired', 'Revoked') DEFAULT 'Active',
    `score_id` INT NULL COMMENT 'Populated once submitted to student_scores',
    `generated_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `expires_at` DATETIME NOT NULL COMMENT 'NOW() + 1 HOUR',
    `consumed_at` DATETIME NULL,
    FOREIGN KEY (`student_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE,
    FOREIGN KEY (`assessment_id`) REFERENCES `assessments`(`assessment_id`) ON DELETE CASCADE,
    FOREIGN KEY (`topic_id`) REFERENCES `topics`(`topic_id`) ON DELETE CASCADE,
    INDEX `idx_ticket_status` (`ticket_code`, `status`),
    INDEX `idx_qr_status` (`qr_token`, `status`),
    INDEX `idx_student_topic` (`student_id`, `topic_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Ensure assessments table has start_date and competitive_enabled
SET @dbname = DATABASE();
SET @tablename = "assessments";
SET @columnname = "start_date";
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      (table_name = @tablename)
      AND (table_schema = @dbname)
      AND (column_name = @columnname)
  ) > 0,
  "SELECT 1",
  "ALTER TABLE assessments ADD COLUMN start_date DATETIME NULL AFTER is_unlocked"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

SET @columnname2 = "competitive_enabled";
SET @preparedStatement2 = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      (table_name = @tablename)
      AND (table_schema = @dbname)
      AND (column_name = @columnname2)
  ) > 0,
  "SELECT 1",
  "ALTER TABLE assessments ADD COLUMN competitive_enabled TINYINT(1) DEFAULT 0 AFTER timer_type"
));
PREPARE alterIfNotExists2 FROM @preparedStatement2;
EXECUTE alterIfNotExists2;
DEALLOCATE PREPARE alterIfNotExists2;
