-- ============================================================================
-- Migration: 20260906_assignment_grading_schema.sql
-- Enterprise Assignment, Submission, and Grading Architecture Schema Updates
-- ============================================================================

-- 1. Grace Period & Pre-submission Diagnostics on Assessments
ALTER TABLE `assessments`
  ADD COLUMN IF NOT EXISTS `allow_grace` TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS `grace_period_minutes` INT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS `late_penalty_percent` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS `min_word_count` INT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `max_word_count` INT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `disallow_blank_pages` TINYINT(1) NOT NULL DEFAULT 1;

-- 2. Grace Tracking, Sanitization Flag, and Audio Note on Student Scores
ALTER TABLE `student_scores`
  ADD COLUMN IF NOT EXISTS `submitted_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS `is_grace_period` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `grace_minutes_used` INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `is_sanitized` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `voice_note_path` VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `voice_note_duration_sec` INT NULL DEFAULT NULL;

-- 3. Cryptographic Submission Receipts (SHA-256)
CREATE TABLE IF NOT EXISTS `submission_receipts` (
  `receipt_id` INT AUTO_INCREMENT PRIMARY KEY,
  `score_id` INT NOT NULL,
  `student_id` INT NOT NULL,
  `assessment_id` INT NOT NULL,
  `sha256_hash` CHAR(64) NOT NULL,
  `file_size_bytes` BIGINT NOT NULL DEFAULT 0,
  `original_filename` VARCHAR(255) NULL,
  `server_timestamp` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `client_ip` VARCHAR(45) NULL,
  INDEX `idx_receipt_hash` (`sha256_hash`),
  INDEX `idx_receipt_student` (`student_id`),
  FOREIGN KEY (`score_id`) REFERENCES `student_scores`(`score_id`) ON DELETE CASCADE,
  FOREIGN KEY (`student_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE,
  FOREIGN KEY (`assessment_id`) REFERENCES `assessments`(`assessment_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 4. Reusable Comment Bank Snippets
CREATE TABLE IF NOT EXISTS `comment_bank_snippets` (
  `snippet_id` INT AUTO_INCREMENT PRIMARY KEY,
  `teacher_id` INT NULL COMMENT 'NULL represents institutional default',
  `shortcut` VARCHAR(50) NOT NULL,
  `expanded_text` TEXT NOT NULL,
  `category` VARCHAR(50) DEFAULT 'General',
  `usage_count` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_teacher_shortcut` (`teacher_id`, `shortcut`),
  FOREIGN KEY (`teacher_id`) REFERENCES `users`(`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 5. Interactive Rubrics & Matrix Scoring
CREATE TABLE IF NOT EXISTS `rubrics` (
  `rubric_id` INT AUTO_INCREMENT PRIMARY KEY,
  `assessment_id` INT NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`assessment_id`) REFERENCES `assessments`(`assessment_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `rubric_criteria` (
  `criterion_id` INT AUTO_INCREMENT PRIMARY KEY,
  `rubric_id` INT NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT NULL,
  `max_points` INT NOT NULL DEFAULT 10,
  `sort_order` INT NOT NULL DEFAULT 1,
  FOREIGN KEY (`rubric_id`) REFERENCES `rubrics`(`rubric_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `submission_rubric_scores` (
  `score_id` INT NOT NULL,
  `criterion_id` INT NOT NULL,
  `points_awarded` INT NOT NULL DEFAULT 0,
  `criterion_feedback` TEXT NULL,
  PRIMARY KEY (`score_id`, `criterion_id`),
  FOREIGN KEY (`score_id`) REFERENCES `student_scores`(`score_id`) ON DELETE CASCADE,
  FOREIGN KEY (`criterion_id`) REFERENCES `rubric_criteria`(`criterion_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Insert default institutional snippets if not already present
INSERT IGNORE INTO `comment_bank_snippets` (`teacher_id`, `shortcut`, `expanded_text`, `category`) VALUES
(NULL, 'cite', 'Please properly cite your scientific sources using APA 7th format (Author, Year, Page/DOI).', 'Formatting'),
(NULL, 'units', 'Ensure all calculated numerical answers include correct SI units (e.g., mol, g/mol, kJ).', 'Accuracy'),
(NULL, 'sigfigs', 'Check your significant figures in the final calculated answer based on provided measurements.', 'Accuracy'),
(NULL, 'detail', 'Great start! Expand your chemical reaction mechanism explanation with intermediate steps.', 'Content'),
(NULL, 'format', 'Review the assignment submission formatting guidelines and structure your work with clear headings.', 'Formatting');
