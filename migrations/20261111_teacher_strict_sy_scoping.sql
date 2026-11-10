-- =============================================================================
-- Migration: 20261111_teacher_strict_sy_scoping.sql
-- Target Database: chemistry_lms_staging
-- Purpose: Expose `sy_id` cleanly in `elementa_student_grades` view from
--          `elementa_game_sessions.sy_id` for strict Teacher Portal SY queries.
-- =============================================================================

CREATE OR REPLACE VIEW `elementa_student_grades` AS
SELECT
    `s`.`session_id` AS `session_id`,
    `s`.`class_id` AS `class_id`,
    `s`.`sy_id` AS `sy_id`,
    `s`.`assessment_id` AS `assessment_id`,
    (CASE `r`.`player_number` WHEN 1 THEN `s`.`student_id_p1` ELSE `s`.`student_id_p2` END) AS `student_id`,
    `r`.`player_number` AS `player_number`,
    `r`.`level_number` AS `assessment_number`,
    `r`.`level_topic` AS `level_topic`,
    `s`.`play_mode` AS `play_mode`,
    `r`.`run_status` AS `run_status`,
    COUNT(`a`.`attempt_id`) AS `questions_attempted`,
    SUM((CASE WHEN (`a`.`is_correct` = 1) THEN 1 ELSE 0 END)) AS `correct_answers`,
    COALESCE(SUM(`a`.`points_awarded`), 0) AS `points_earned`,
    COUNT(`a`.`attempt_id`) AS `points_possible`,
    ROUND(((COALESCE(SUM(`a`.`points_awarded`), 0) / NULLIF(COUNT(`a`.`attempt_id`), 0)) * 100), 2) AS `grade_percent`,
    ROUND(AVG(`a`.`response_time_s`), 2) AS `avg_response_time_s`,
    SUM((CASE WHEN (`a`.`is_timeout` = 1) THEN 1 ELSE 0 END)) AS `timeouts`,
    `r`.`started_at` AS `started_at`,
    `r`.`ended_at` AS `ended_at`
FROM (`elementa_level_runs` `r`
JOIN `elementa_game_sessions` `s` ON (`s`.`session_id` = `r`.`session_id`))
LEFT JOIN `elementa_customer_attempts` `a` ON (`a`.`run_id` = `r`.`run_id`)
GROUP BY
    `s`.`session_id`,
    `s`.`class_id`,
    `s`.`sy_id`,
    `s`.`assessment_id`,
    (CASE `r`.`player_number` WHEN 1 THEN `s`.`student_id_p1` ELSE `s`.`student_id_p2` END),
    `r`.`player_number`,
    `r`.`level_number`,
    `r`.`level_topic`,
    `s`.`play_mode`,
    `r`.`run_status`,
    `r`.`started_at`,
    `r`.`ended_at`;

