-- =============================================================================
-- REVERSE MIGRATION: 20261108_school_year_comprehensive_architecture.down.sql
-- Database: chemistry_lms_staging
-- Drops all columns introduced by Phase 1 School Year enhancements.
-- =============================================================================

ALTER TABLE `school_years`
  DROP COLUMN IF EXISTS `sy_code`,
  DROP COLUMN IF EXISTS `start_date`,
  DROP COLUMN IF EXISTS `end_date`,
  DROP COLUMN IF EXISTS `status`,
  DROP COLUMN IF EXISTS `sem1_start_date`,
  DROP COLUMN IF EXISTS `sem1_end_date`,
  DROP COLUMN IF EXISTS `sem1_enrollment_start`,
  DROP COLUMN IF EXISTS `sem1_enrollment_end`,
  DROP COLUMN IF EXISTS `q1_start_date`,
  DROP COLUMN IF EXISTS `q1_end_date`,
  DROP COLUMN IF EXISTS `q1_grade_deadline`,
  DROP COLUMN IF EXISTS `q2_start_date`,
  DROP COLUMN IF EXISTS `q2_end_date`,
  DROP COLUMN IF EXISTS `q2_grade_deadline`,
  DROP COLUMN IF EXISTS `sem2_start_date`,
  DROP COLUMN IF EXISTS `sem2_end_date`,
  DROP COLUMN IF EXISTS `sem2_enrollment_start`,
  DROP COLUMN IF EXISTS `sem2_enrollment_end`,
  DROP COLUMN IF EXISTS `q3_start_date`,
  DROP COLUMN IF EXISTS `q3_end_date`,
  DROP COLUMN IF EXISTS `q3_grade_deadline`,
  DROP COLUMN IF EXISTS `q4_start_date`,
  DROP COLUMN IF EXISTS `q4_end_date`,
  DROP COLUMN IF EXISTS `q4_grade_deadline`,
  DROP COLUMN IF EXISTS `enforce_prerequisite`,
  DROP COLUMN IF EXISTS `passing_threshold`,
  DROP COLUMN IF EXISTS `source_sy_id`,
  DROP COLUMN IF EXISTS `rollover_materials`,
  DROP COLUMN IF EXISTS `rollover_assessments`,
  DROP COLUMN IF EXISTS `rollover_question_bank`,
  DROP COLUMN IF EXISTS `rollover_announcements`,
  DROP COLUMN IF EXISTS `default_rollover_visibility`;

