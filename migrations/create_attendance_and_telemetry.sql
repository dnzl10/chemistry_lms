-- Migration: create_attendance_and_telemetry.sql
-- Description: Creates attendance_records table and enhances activity_logs with network telemetry

CREATE TABLE IF NOT EXISTS `attendance_records` (
  `attendance_id` INT(11) NOT NULL AUTO_INCREMENT,
  `student_id` INT(11) NOT NULL,
  `class_id` INT(11) NOT NULL,
  `session_date` DATE NOT NULL,
  `check_in_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `status` ENUM('Present', 'Late', 'Absent', 'Excused') NOT NULL DEFAULT 'Present',
  `attendance_method` ENUM('Manual_Teacher', 'System_Activity') NOT NULL DEFAULT 'Manual_Teacher',
  `teacher_id` INT(11) DEFAULT NULL COMMENT 'Teacher who recorded or modified',
  `override_reason` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`attendance_id`),
  UNIQUE KEY `uniq_student_class_date` (`student_id`, `class_id`, `session_date`),
  KEY `idx_class_date` (`class_id`, `session_date`),
  CONSTRAINT `fk_att_student` FOREIGN KEY (`student_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_att_class` FOREIGN KEY (`class_id`) REFERENCES `classes` (`class_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Enhance activity_logs for forensic network telemetry
SET @exist_ip = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'activity_logs' AND column_name = 'ip_address');
SET @sql_ip = IF(@exist_ip = 0, 'ALTER TABLE `activity_logs` ADD COLUMN `ip_address` VARCHAR(45) NULL AFTER `actor_role`', 'SELECT 1');
PREPARE stmt_ip FROM @sql_ip;
EXECUTE stmt_ip;
DEALLOCATE PREPARE stmt_ip;

SET @exist_ua = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'activity_logs' AND column_name = 'user_agent');
SET @sql_ua = IF(@exist_ua = 0, 'ALTER TABLE `activity_logs` ADD COLUMN `user_agent` VARCHAR(255) NULL AFTER `ip_address`', 'SELECT 1');
PREPARE stmt_ua FROM @sql_ua;
EXECUTE stmt_ua;
DEALLOCATE PREPARE stmt_ua;

SET @exist_sid = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'activity_logs' AND column_name = 'session_id');
SET @sql_sid = IF(@exist_sid = 0, 'ALTER TABLE `activity_logs` ADD COLUMN `session_id` VARCHAR(255) NULL AFTER `user_agent`', 'SELECT 1');
PREPARE stmt_sid FROM @sql_sid;
EXECUTE stmt_sid;
DEALLOCATE PREPARE stmt_sid;
