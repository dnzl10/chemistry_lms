-- ============================================================================
-- 01_purge_dead_tables.sql
-- Unified Arcade Single Source of Truth (SSOT) Migration
-- Drops legacy web-game dead tables and purges dead web-game score rows.
-- ============================================================================

SET FOREIGN_KEY_CHECKS = 0;

-- 1. Drop dead foreign keys
ALTER TABLE remediation_materials DROP FOREIGN KEY IF EXISTS fk_rem_question;

-- 2. Drop dead tables
DROP TABLE IF EXISTS student_responses;
DROP TABLE IF EXISTS answer_sequences;
DROP TABLE IF EXISTS assessment_questions;
DROP TABLE IF EXISTS question_bank;
DROP TABLE IF EXISTS competitive_matches;
DROP TABLE IF EXISTS active_sessions;
DROP TABLE IF EXISTS leaderboard_history;
DROP TABLE IF EXISTS level_thresholds;
DROP TABLE IF EXISTS student_forum_views;
DROP TABLE IF EXISTS notification_preferences;

-- 3. Drop legacy trigger
DROP TRIGGER IF EXISTS update_total_exp;

-- 4. Clean legacy web-game score rows (preserving assignment files)
DELETE FROM student_scores WHERE file_path IS NULL AND voice_note_path IS NULL;

SET FOREIGN_KEY_CHECKS = 1;
