-- =============================================================================
-- Migration: 20261111_student_strict_sy_scoping.sql
-- Target Database: chemistry_lms_staging
-- Purpose: Add strict School Year (sy_id) columns and indexes to
--          `elementa_leaderboard` and `elementa_assessment_tickets`, and expose
--          `sy_id` on `leaderboard_history` and `question_bank` SQL VIEWs.
-- =============================================================================

-- 1. elementa_leaderboard: add sy_id + composite index
ALTER TABLE `elementa_leaderboard`
    ADD COLUMN IF NOT EXISTS `sy_id` INT(11) NULL DEFAULT NULL AFTER `class_id`;

ALTER TABLE `elementa_leaderboard`
    ADD INDEX IF NOT EXISTS `idx_el_sy` (`sy_id`, `class_id`);

-- 2. leaderboard_history VIEW: expose elementa_leaderboard.sy_id
CREATE OR REPLACE VIEW `leaderboard_history` AS
SELECT
    `el`.`lb_id` AS `history_id`,
    `el`.`student_id` AS `student_id`,
    (SELECT `c`.`subject_id` FROM `classes` AS `c` WHERE `c`.`class_id` = `el`.`class_id` LIMIT 1) AS `subject_id`,
    `el`.`sy_id` AS `sy_id`,
    ROW_NUMBER() OVER (ORDER BY `el`.`best_score_total` DESC) AS `rank_achieved`,
    `el`.`best_score_total` AS `total_exp_snapshot`,
    `el`.`last_played_at` AS `awarded_date`
FROM `elementa_leaderboard` AS `el`;

-- 3. elementa_assessment_tickets: add sy_id + index
ALTER TABLE `elementa_assessment_tickets`
    ADD COLUMN IF NOT EXISTS `sy_id` INT(11) NULL DEFAULT NULL AFTER `assessment_id`;

ALTER TABLE `elementa_assessment_tickets`
    ADD INDEX IF NOT EXISTS `idx_eat_sy` (`sy_id`);

-- 4. question_bank VIEW: expose elementa_questions.sy_id
CREATE OR REPLACE VIEW `question_bank` AS
SELECT 
    `question_id`,
    `topic_id`,
    `teacher_id`,
    `prompt` AS `question_text`,
    NULL AS `instruction_override`,
    NULL AS `media_path`,
    NULL AS `media_type`,
    `difficulty`,
    'Standard' AS `input_mode`,
    'standard_mcq' AS `mechanic_type`,
    `points` * 100 AS `base_exp`,
    `points`,
    `time_limit_s` AS `time_limit`,
    0 AS `is_multiple_answer`,
    1 AS `required_answers_count`,
    NULL AS `option_a`,
    NULL AS `option_a_image`,
    NULL AS `option_b`,
    NULL AS `option_b_image`,
    NULL AS `option_c`,
    NULL AS `option_c_image`,
    NULL AS `option_d`,
    NULL AS `option_d_image`,
    `answer_text` AS `correct_answer`,
    NULL AS `numeric_answer`,
    0.0000 AS `numeric_tolerance`,
    0 AS `is_ai_generated`,
    `verification_status`,
    `verified_by`,
    `verified_at`,
    `rejection_reason`,
    `created_at`,
    `updated_at`,
    `sy_id`
FROM `elementa_questions`;
