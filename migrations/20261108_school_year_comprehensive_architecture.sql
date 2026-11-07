-- =============================================================================
-- Migration: 20261108_school_year_comprehensive_architecture.sql
-- Target Database: chemistry_lms_staging
-- Adds complete metadata, status, semestral/quarterly timeline,
-- subject-specific enrollment windows, prerequisite controls, and rollover options.
-- =============================================================================

ALTER TABLE `school_years`
  ADD COLUMN IF NOT EXISTS `sy_code` VARCHAR(20) NULL AFTER `sy_range`,
  ADD COLUMN IF NOT EXISTS `start_date` DATE NULL AFTER `sy_code`,
  ADD COLUMN IF NOT EXISTS `end_date` DATE NULL AFTER `start_date`,
  ADD COLUMN IF NOT EXISTS `status` ENUM('Draft', 'Active', 'Archived') NOT NULL DEFAULT 'Draft' AFTER `end_date`,
  
  -- Semester 1 (Chemistry 1) Timeline & Enrollment Controls
  ADD COLUMN IF NOT EXISTS `sem1_start_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `sem1_end_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `sem1_enrollment_start` DATETIME NULL,
  ADD COLUMN IF NOT EXISTS `sem1_enrollment_end` DATETIME NULL,
  ADD COLUMN IF NOT EXISTS `q1_start_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `q1_end_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `q1_grade_deadline` DATETIME NULL,
  ADD COLUMN IF NOT EXISTS `q2_start_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `q2_end_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `q2_grade_deadline` DATETIME NULL,

  -- Semester 2 (Chemistry 2) Timeline & Enrollment Controls
  ADD COLUMN IF NOT EXISTS `sem2_start_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `sem2_end_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `sem2_enrollment_start` DATETIME NULL,
  ADD COLUMN IF NOT EXISTS `sem2_enrollment_end` DATETIME NULL,
  ADD COLUMN IF NOT EXISTS `q3_start_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `q3_end_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `q3_grade_deadline` DATETIME NULL,
  ADD COLUMN IF NOT EXISTS `q4_start_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `q4_end_date` DATE NULL,
  ADD COLUMN IF NOT EXISTS `q4_grade_deadline` DATETIME NULL,

  -- Subject-Specific Prerequisite Rule & Threshold
  ADD COLUMN IF NOT EXISTS `enforce_prerequisite` TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS `passing_threshold` DECIMAL(5,2) NOT NULL DEFAULT 75.00,

  -- Content Rollover & Retention Settings
  ADD COLUMN IF NOT EXISTS `source_sy_id` INT(11) NULL,
  ADD COLUMN IF NOT EXISTS `rollover_materials` TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS `rollover_assessments` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `rollover_question_bank` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `rollover_announcements` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `default_rollover_visibility` ENUM('visible', 'hidden') NOT NULL DEFAULT 'visible';

