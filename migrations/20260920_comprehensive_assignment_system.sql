-- ============================================================================
-- Migration: 20260920_comprehensive_assignment_system.sql
-- Enterprise Assignment, Metadata, Audience, Group Sets & Security Schema
-- ============================================================================

-- 1. ENHANCE ASSESSMENTS TABLE (Assignment Details, Files, Audience & Policies)
ALTER TABLE `assessments`
  ADD COLUMN IF NOT EXISTS `category` ENUM('Homework', 'Laboratory', 'Performance Task', 'Seatwork', 'Others') NOT NULL DEFAULT 'Homework',
  ADD COLUMN IF NOT EXISTS `objectives` TEXT NULL,
  ADD COLUMN IF NOT EXISTS `description` TEXT NULL,
  ADD COLUMN IF NOT EXISTS `instructions` LONGTEXT NULL,
  ADD COLUMN IF NOT EXISTS `format_file_path` VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS `format_file_name` VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS `sample_file_path` VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS `sample_file_name` VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS `allowed_extensions` VARCHAR(255) NOT NULL DEFAULT '.pdf,.docx,.doc,.xlsx,.pptx,.zip,.png,.jpg',
  ADD COLUMN IF NOT EXISTS `max_file_size_mb` INT NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS `target_audience` ENUM('everyone', 'sections', 'students') NOT NULL DEFAULT 'everyone',
  ADD COLUMN IF NOT EXISTS `is_group_assignment` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `group_set_id` INT NULL,
  ADD COLUMN IF NOT EXISTS `group_submission_mode` ENUM('one_per_group', 'individual') NOT NULL DEFAULT 'one_per_group',
  ADD COLUMN IF NOT EXISTS `group_grading_mode` ENUM('shared_grade', 'individual_grade') NOT NULL DEFAULT 'shared_grade',
  ADD COLUMN IF NOT EXISTS `allow_resubmission` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `max_attempts` INT NOT NULL DEFAULT 1;

-- 2. TARGET AUDIENCE JUNCTION TABLE
CREATE TABLE IF NOT EXISTS `assignment_audiences` (
  `audience_id` INT AUTO_INCREMENT PRIMARY KEY,
  `assessment_id` INT NOT NULL,
  `class_id` INT NULL COMMENT 'Set when target_audience = sections',
  `student_id` INT NULL COMMENT 'Set when target_audience = students',
  INDEX `idx_asgn_aud_assessment` (`assessment_id`),
  INDEX `idx_asgn_aud_class` (`class_id`),
  INDEX `idx_asgn_aud_student` (`student_id`),
  FOREIGN KEY (`assessment_id`) REFERENCES `assessments`(`assessment_id`) ON DELETE CASCADE,
  FOREIGN KEY (`class_id`) REFERENCES `classes`(`class_id`) ON DELETE CASCADE,
  FOREIGN KEY (`student_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3. GROUP MANAGEMENT INFRASTRUCTURE
CREATE TABLE IF NOT EXISTS `group_sets` (
  `group_set_id` INT AUTO_INCREMENT PRIMARY KEY,
  `class_id` INT NOT NULL,
  `title` VARCHAR(150) NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_group_sets_class` (`class_id`),
  FOREIGN KEY (`class_id`) REFERENCES `classes`(`class_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `student_groups` (
  `group_id` INT AUTO_INCREMENT PRIMARY KEY,
  `group_set_id` INT NOT NULL,
  `group_name` VARCHAR(100) NOT NULL,
  INDEX `idx_student_groups_set` (`group_set_id`),
  FOREIGN KEY (`group_set_id`) REFERENCES `group_sets`(`group_set_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `group_members` (
  `group_id` INT NOT NULL,
  `student_id` INT NOT NULL,
  PRIMARY KEY (`group_id`, `student_id`),
  INDEX `idx_group_members_student` (`student_id`),
  FOREIGN KEY (`group_id`) REFERENCES `student_groups`(`group_id`) ON DELETE CASCADE,
  FOREIGN KEY (`student_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 4. DELIVERABLE STORAGE & ATTEMPT VERSIONING ON STUDENT_SCORES
ALTER TABLE `student_scores`
  ADD COLUMN IF NOT EXISTS `attempt_number` INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS `group_id` INT NULL,
  ADD COLUMN IF NOT EXISTS `submitted_by_user_id` INT NULL,
  ADD COLUMN IF NOT EXISTS `file_path` VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS `file_size_bytes` BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `original_filename` VARCHAR(255) NULL,
  ADD INDEX IF NOT EXISTS `idx_scores_group` (`group_id`);
