-- =============================================================================
-- Migration: 20261110_simulation_quizzes_sy_scoping.sql
-- Target Database: chemistry_lms_staging
-- Purpose: Add strict School Year (sy_id) columns and indexes to
--          elementa_simulation_custom_quizzes and
--          elementa_simulation_quiz_submissions.
-- =============================================================================

-- 1. elementa_simulation_custom_quizzes: add sy_id + indexes
ALTER TABLE `elementa_simulation_custom_quizzes`
    ADD COLUMN IF NOT EXISTS `sy_id` INT(11) NULL DEFAULT NULL AFTER `created_by`;

ALTER TABLE `elementa_simulation_custom_quizzes`
    ADD INDEX IF NOT EXISTS `idx_sim_quiz_sy` (`sy_id`);

ALTER TABLE `elementa_simulation_custom_quizzes`
    ADD INDEX IF NOT EXISTS `idx_sim_quiz_slug_sy` (`simulation_slug`, `sy_id`, `is_active`);

-- 2. elementa_simulation_quiz_submissions: add sy_id + index
ALTER TABLE `elementa_simulation_quiz_submissions`
    ADD COLUMN IF NOT EXISTS `sy_id` INT(11) NULL DEFAULT NULL AFTER `quiz_id`;

ALTER TABLE `elementa_simulation_quiz_submissions`
    ADD INDEX IF NOT EXISTS `idx_sim_sub_sy` (`sy_id`);

