-- ============================================================
-- Migration: Redesigned Announcement & Broadcast Architecture
-- ============================================================

-- 1. Extend announcements table
-- Check and add columns safely if they do not exist
SET @dbname = DATABASE();
SET @tablename = "announcements";

-- Add scope
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "scope"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE `announcements` ADD COLUMN `scope` ENUM('global', 'subject', 'class') NOT NULL DEFAULT 'class' AFTER `class_id`;"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Add is_critical
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "is_critical"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE `announcements` ADD COLUMN `is_critical` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_priority`;"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Add due_date
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "due_date"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE `announcements` ADD COLUMN `due_date` DATETIME NULL DEFAULT NULL AFTER `content`;"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Add allow_replies
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "allow_replies"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE `announcements` ADD COLUMN `allow_replies` TINYINT(1) NOT NULL DEFAULT 0 AFTER `due_date`;"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Add webhook_dispatched
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "webhook_dispatched"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE `announcements` ADD COLUMN `webhook_dispatched` TINYINT(1) NOT NULL DEFAULT 0 AFTER `allow_replies`;"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Add attachment_url
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "attachment_url"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE `announcements` ADD COLUMN `attachment_url` VARCHAR(255) NULL DEFAULT NULL AFTER `webhook_dispatched`;"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Add attachment_name
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "attachment_name"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE `announcements` ADD COLUMN `attachment_name` VARCHAR(255) NULL DEFAULT NULL AFTER `attachment_url`;"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Add attachment_type
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "attachment_type"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE `announcements` ADD COLUMN `attachment_type` VARCHAR(50) NULL DEFAULT NULL AFTER `attachment_name`;"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- 2. Micro-Comprehension & Acknowledgment Tracking
CREATE TABLE IF NOT EXISTS `announcement_acknowledgments` (
  `ack_id` INT(11) NOT NULL AUTO_INCREMENT,
  `announcement_id` INT(11) NOT NULL,
  `user_id` INT(11) NOT NULL,
  `response_state` ENUM('understood', 'clarification_needed') NOT NULL,
  `note` VARCHAR(255) NULL DEFAULT NULL,
  `acknowledged_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ack_id`),
  UNIQUE KEY `uniq_ann_user` (`announcement_id`, `user_id`),
  CONSTRAINT `fk_ack_announcement` FOREIGN KEY (`announcement_id`) REFERENCES `announcements` (`announcement_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ack_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3. Announcement Discussions / Comments (when allow_replies = 1)
CREATE TABLE IF NOT EXISTS `announcement_comments` (
  `comment_id` INT(11) NOT NULL AUTO_INCREMENT,
  `announcement_id` INT(11) NOT NULL,
  `user_id` INT(11) NOT NULL,
  `comment_text` TEXT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`comment_id`),
  KEY `announcement_id` (`announcement_id`),
  CONSTRAINT `fk_comm_announcement` FOREIGN KEY (`announcement_id`) REFERENCES `announcements` (`announcement_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_comm_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 4. Direct-to-Community Webhook Configuration
CREATE TABLE IF NOT EXISTS `webhook_configs` (
  `config_id` INT(11) NOT NULL AUTO_INCREMENT,
  `scope` ENUM('global', 'class') NOT NULL DEFAULT 'class',
  `class_id` INT(11) NULL DEFAULT NULL,
  `platform` ENUM('discord', 'telegram') NOT NULL,
  `webhook_url` TEXT NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`config_id`),
  KEY `class_id` (`class_id`),
  CONSTRAINT `fk_webhook_class` FOREIGN KEY (`class_id`) REFERENCES `classes` (`class_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
