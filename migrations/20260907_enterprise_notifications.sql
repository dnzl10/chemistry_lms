-- ============================================================================
-- Migration: 20260907_enterprise_notifications.sql
-- Enterprise In-App Notification System Schema
-- ============================================================================

-- 1. Dedicated Notifications Table
CREATE TABLE IF NOT EXISTS `notifications` (
  `notification_id` INT(11) NOT NULL AUTO_INCREMENT,
  `user_id` INT(11) NOT NULL COMMENT 'Recipient of the notification',
  `actor_id` INT(11) DEFAULT NULL COMMENT 'User who triggered the notification, if applicable',
  `role` ENUM('Student', 'Teacher', 'Admin') NOT NULL,
  `category` ENUM('academic', 'assessment', 'forum', 'integrity', 'system', 'social') NOT NULL DEFAULT 'academic',
  `priority` ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal',
  `event_type` VARCHAR(64) NOT NULL COMMENT 'e.g. submission_created, grade_released, cheating_flagged',
  `title` VARCHAR(255) NOT NULL,
  `message` TEXT NOT NULL,
  `target_url` VARCHAR(500) DEFAULT NULL COMMENT 'Deep link redirect URL for modal click',
  `metadata` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`) or `metadata` is null),
  `is_read` TINYINT(1) NOT NULL DEFAULT 0,
  `read_at` DATETIME DEFAULT NULL,
  `is_dismissed` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`notification_id`),
  KEY `idx_user_unread` (`user_id`, `is_read`, `is_dismissed`),
  KEY `idx_user_created` (`user_id`, `created_at` DESC),
  KEY `idx_category` (`category`),
  CONSTRAINT `fk_notif_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_notif_actor` FOREIGN KEY (`actor_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 2. Notification Preferences Table
CREATE TABLE IF NOT EXISTS `notification_preferences` (
  `preference_id` INT(11) NOT NULL AUTO_INCREMENT,
  `user_id` INT(11) NOT NULL,
  `category` VARCHAR(50) NOT NULL,
  `in_app_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `email_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`preference_id`),
  UNIQUE KEY `uq_user_category` (`user_id`, `category`),
  CONSTRAINT `fk_pref_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
