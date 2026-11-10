-- =============================================================================
-- Migration: 20261110_student_dashboard_sy_scoping.sql
-- Target Database: chemistry_lms_staging
-- Purpose: Add strict School Year (sy_id) columns and indexes to
--          calendar_events, forum_topics, and student_progress, and backfill
--          existing records alongside announcements and class_students.
-- =============================================================================

-- 1. calendar_events: add sy_id + index
ALTER TABLE `calendar_events`
    ADD COLUMN IF NOT EXISTS `sy_id` INT(11) NULL DEFAULT NULL AFTER `class_id`;

ALTER TABLE `calendar_events`
    ADD INDEX IF NOT EXISTS `idx_calendar_events_sy` (`sy_id`);

-- 2. forum_topics: add sy_id + index
ALTER TABLE `forum_topics`
    ADD COLUMN IF NOT EXISTS `sy_id` INT(11) NULL DEFAULT NULL AFTER `class_id`;

ALTER TABLE `forum_topics`
    ADD INDEX IF NOT EXISTS `idx_forum_topics_sy` (`sy_id`);

-- 3. student_progress: add sy_id + per-SY unique index (preserving student_id FK)
ALTER TABLE `student_progress`
    ADD COLUMN IF NOT EXISTS `sy_id` INT(11) NULL DEFAULT NULL AFTER `subject_id`;

ALTER TABLE `student_progress`
    ADD INDEX IF NOT EXISTS `idx_student_progress_sy` (`sy_id`);

ALTER TABLE `student_progress`
    ADD UNIQUE INDEX IF NOT EXISTS `uniq_student_subject_sy` (`student_id`, `subject_id`, `sy_id`);

