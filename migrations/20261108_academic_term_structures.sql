-- ============================================================================
-- Migration: 20261108_academic_term_structures.sql
-- Description: Non-destructive addition of Academic Term & Grading Period
--              structures to support Semestral, Trimester, and Quarterly cycles.
-- Target DB: chemistry_lms_staging (first), chemistry_lms (on promotion)
-- ============================================================================

-- 1. Extend school_years with metadata and term structure type
ALTER TABLE `school_years`
  ADD COLUMN IF NOT EXISTS `sy_code` VARCHAR(30) NULL AFTER `sy_range`,
  ADD COLUMN IF NOT EXISTS `term_structure` ENUM('semestral', 'trimester', 'quarterly') NOT NULL DEFAULT 'quarterly' AFTER `sy_code`,
  ADD COLUMN IF NOT EXISTS `description` TEXT NULL AFTER `term_structure`,
  ADD COLUMN IF NOT EXISTS `start_date` DATE NULL AFTER `description`,
  ADD COLUMN IF NOT EXISTS `end_date` DATE NULL AFTER `start_date`,
  ADD COLUMN IF NOT EXISTS `status` ENUM('draft', 'active', 'archived') NOT NULL DEFAULT 'active' AFTER `end_date`;

-- Backfill sy_code for existing school_years
UPDATE `school_years`
SET `sy_code` = CONCAT('SY', REPLACE(`sy_range`, '-', ''))
WHERE `sy_code` IS NULL OR `sy_code` = '';

-- 2. Create academic_terms table
CREATE TABLE IF NOT EXISTS `academic_terms` (
  `term_id` INT AUTO_INCREMENT PRIMARY KEY,
  `sy_id` INT NOT NULL,
  `term_name` VARCHAR(60) NOT NULL,
  `term_code` VARCHAR(20) NOT NULL,
  `term_order` INT NOT NULL DEFAULT 1,
  `start_date` DATE NULL,
  `end_date` DATE NULL,
  `enrollment_start` DATETIME NULL,
  `enrollment_end` DATETIME NULL,
  `add_drop_deadline` DATETIME NULL,
  `grading_deadline` DATETIME NULL,
  `status` ENUM('draft', 'open', 'grading_locked', 'archived') NOT NULL DEFAULT 'open',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_term_sy` (`sy_id`),
  INDEX `idx_term_status` (`status`),
  CONSTRAINT `fk_academic_terms_sy` FOREIGN KEY (`sy_id`) REFERENCES `school_years` (`sy_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3. Extend quarters with custom display labels (e.g., 'Midterm Period', 'Final Period')
ALTER TABLE `quarters`
  ADD COLUMN IF NOT EXISTS `display_label` VARCHAR(50) NULL AFTER `quarter_number`;

-- 4. Extend classes with term_id foreign key
ALTER TABLE `classes`
  ADD COLUMN IF NOT EXISTS `term_id` INT NULL AFTER `sy_id`;

-- 5. Safe backfill: Ensure every existing school year has at least one active term
INSERT INTO `academic_terms` (`sy_id`, `term_name`, `term_code`, `term_order`, `status`, `is_active`)
SELECT `sy_id`, 'Academic Year (Annual)', 'AY-DEFAULT', 1, 'open', 1
FROM `school_years` sy
WHERE NOT EXISTS (
  SELECT 1 FROM `academic_terms` at WHERE at.sy_id = sy.sy_id
);

-- 6. Link existing classes to their school year's primary term
UPDATE `classes` c
JOIN `academic_terms` at ON at.sy_id = c.sy_id AND at.term_order = 1
SET c.term_id = at.term_id
WHERE c.term_id IS NULL;

