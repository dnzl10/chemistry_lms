-- =============================================================================
-- Migration: 20261110_teacher_forums_sy_scoping.sql
-- Target Database: chemistry_lms_staging
-- Purpose: Ensure strict School Year (sy_id) schema readiness and indexes on
--          `forum_topics` for Teacher Forums and Teacher Forum View scoping.
-- =============================================================================

-- 1. Ensure `forum_topics.sy_id` column exists
ALTER TABLE `forum_topics`
    ADD COLUMN IF NOT EXISTS `sy_id` INT(11) NULL DEFAULT NULL AFTER `class_id`;

-- 2. Ensure SY lookup & composite teacher-forum scoping indexes exist
ALTER TABLE `forum_topics`
    ADD INDEX IF NOT EXISTS `idx_forum_topics_sy` (`sy_id`);

ALTER TABLE `forum_topics`
    ADD INDEX IF NOT EXISTS `idx_forum_topics_sy_teacher` (`sy_id`, `teacher_id`, `subject_id`);

ALTER TABLE `forum_topics`
    ADD INDEX IF NOT EXISTS `idx_forum_topics_sy_class` (`sy_id`, `class_id`);

