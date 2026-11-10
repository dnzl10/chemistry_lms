-- =============================================================================
-- Migration: 20261111_arcade_telemetry_sy_scoping.sql
-- Target Database: chemistry_lms_staging
-- Purpose: Add strict School Year (sy_id) column and indexes to
--          `elementa_game_sessions` for Teacher Arcade Telemetry scoping.
-- =============================================================================

ALTER TABLE `elementa_game_sessions`
    ADD COLUMN IF NOT EXISTS `sy_id` INT(11) NULL DEFAULT NULL AFTER `class_id`;

ALTER TABLE `elementa_game_sessions`
    ADD INDEX IF NOT EXISTS `idx_egs_sy` (`sy_id`);

ALTER TABLE `elementa_game_sessions`
    ADD INDEX IF NOT EXISTS `idx_egs_sy_class` (`sy_id`, `class_id`);

